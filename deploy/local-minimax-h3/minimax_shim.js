#!/usr/bin/env node
/**
 * minimax_shim.js — MiniMax 协议兼容层 (huobao -> 本地 ComfyUI MiniMax-H3)
 *
 * 实现 huobao minimax-video 适配器所需的两个端点:
 *   POST /v2/video_generation            -> { task_id }
 *   GET  /v2/query/video_generation/{id} -> { task: { status, content:{url}, error } }
 *
 * 内部把请求转换为 ComfyUI API prompt (MiniMaxH3ImageToVideo 支持首尾帧),
 * 轮询 /history, 下载成片到 huobao 静态目录, 返回 huobao 公网 URL。
 *
 * 运行: node minimax_shim.js  (默认 127.0.0.1:9001)
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');

const PORT = parseInt(process.env.SHIM_PORT || '9001', 10);
const COMFY = process.env.COMFY_URL || 'http://127.0.0.1:8188';
const OUT_DIR = process.env.SHIM_OUT_DIR || '/home/huobao_drama/data/static/videos';
const PUBLIC_BASE = process.env.SHIM_PUBLIC_BASE || 'https://drama.crayfish.cloud/static/videos';
const STATE_FILE = process.env.SHIM_STATE || '/tmp/minimax_shim_state.json';
const MODEL_UNET = process.env.SHIM_UNET || 'minimax_h3_fl2va_pruned_int8_convrot.safetensors';
const MODEL_CLIP = process.env.SHIM_CLIP || 'qwen3vl_32b_minimax_h3_nvfp4_awq.safetensors';
const MODEL_LORA = process.env.SHIM_LORA || 'minimax_h3_fl2v_turbo_8step_v1.0_comfyui_bf16.safetensors';
const STEPS = parseInt(process.env.SHIM_STEPS || '8', 10);
// H3 原生输出 1344x768/24fps/32kHz，与其他镜头(Wan 1280x720/30fps/44.1kHz)混拼会被
// ffmpeg concat 丢包(音频整轨丢弃+视频缺帧)，故落盘前统一归一化到 1280x720/30fps/44.1kHz。
const FFMPEG = process.env.SHIM_FFMPEG || '/usr/local/bin/ffmpeg';
const NORM_W = parseInt(process.env.SHIM_NORM_W || '1280', 10);
const NORM_H = parseInt(process.env.SHIM_NORM_H || '720', 10);
const NORM_FPS = parseInt(process.env.SHIM_NORM_FPS || '30', 10);

// 分辨率/宽高比映射 (768P 档, 适配 32G 显存)
const RATIO_MAP = {
  '16:9': [1344, 768],
  '9:16': [768, 1344],
  '1:1': [1024, 1024],
  '4:3': [1152, 864],
  '3:4': [864, 1152],
  '21:9': [1536, 640],
};

const tasks = new Map(); // task_id -> { prompt_id, status, url, error, created }

// ---------- 持久化(重启后仍可查询已完成任务) ----------
function loadState() {
  try {
    const d = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    for (const [k, v] of Object.entries(d.tasks || {})) tasks.set(k, v);
    console.log('[shim] restored', tasks.size, 'tasks from state');
  } catch (e) { /* first run */ }
}
function saveState() {
  try {
    fs.writeFileSync(STATE_FILE, JSON.stringify({ tasks: Object.fromEntries(tasks) }, null, 1));
  } catch (e) { /* ignore */ }
}

// ---------- HTTP 工具 ----------
function request(urlStr, opts = {}, body = null, isBuffer = false) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname, port: u.port, path: u.pathname + u.search,
      method: opts.method || 'GET', headers: opts.headers || {},
      timeout: opts.timeout || 120000,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (isBuffer) return resolve({ status: res.statusCode, buf });
        const txt = buf.toString('utf8');
        try { resolve({ status: res.statusCode, json: JSON.parse(txt), txt }); }
        catch (e) { resolve({ status: res.statusCode, txt }); }
      });
    });
    req.on('timeout', () => req.destroy(new Error('request timeout: ' + urlStr)));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function download(urlStr, timeout = 60000) {
  return request(urlStr, { timeout }, null, true).then((r) => {
    if (r.status !== 200 || !r.buf || r.buf.length < 100) {
      throw new Error('download failed: ' + urlStr + ' status=' + r.status);
    }
    return r.buf;
  });
}

// ---------- ComfyUI 交互 ----------
async function comfyUploadImage(buf, filename) {
  const boundary = '----shim' + crypto.randomBytes(8).toString('hex');
  const parts = [];
  const pushField = (name, value) => {
    parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="' + name + '"\r\n\r\n' + value + '\r\n'));
  };
  pushField('overwrite', 'true');
  parts.push(Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="image"; filename="' + filename + '"\r\nContent-Type: application/octet-stream\r\n\r\n'));
  parts.push(buf);
  parts.push(Buffer.from('\r\n--' + boundary + '--\r\n'));
  const body = Buffer.concat(parts);
  const r = await request(COMFY + '/upload/image', {
    method: 'POST',
    headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length },
    timeout: 120000,
  }, body);
  if (!r.json || !r.json.name) throw new Error('comfy upload failed: ' + JSON.stringify(r.json || r.txt));
  return r.json.name;
}

function snapLength(seconds) {
  // H3 帧数网格: 5 + 17k (24fps); 5s -> 124
  const fps = 24;
  let n = Math.max(5, Math.round(seconds * fps));
  n = 5 + 17 * Math.round((n - 5) / 17); // 就近吸附到 5+17k 网格 (5s -> 124)
  return Math.min(3600, Math.max(5, n));
}

function buildWorkflow({ prompt, width, height, length, seed, firstImg, lastImg, prefix }) {
  const wf = {
    '1': { class_type: 'UNETLoader', inputs: { unet_name: MODEL_UNET, weight_dtype: 'default' } },
    '2': { class_type: 'LoraLoaderModelOnly', inputs: { model: ['1', 0], lora_name: MODEL_LORA, strength_model: 1.0 } },
    '3': { class_type: 'CLIPLoader', inputs: { clip_name: MODEL_CLIP, type: 'minimax' } },
    '4': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_video_vae_fp16.safetensors' } },
    '5': { class_type: 'VAELoader', inputs: { vae_name: 'minimax_h3_audio_vae_fp32.safetensors' } },
    '8': {
      class_type: 'MiniMaxH3ImageToVideo',
      inputs: {
        clip: ['3', 0], vae: ['4', 0],
        prompt: prompt, width: width, height: height, length: length,
      },
    },
    '9': { class_type: 'KSamplerSelect', inputs: { sampler_name: 'res_multistep' } },
    '10': { class_type: 'BasicScheduler', inputs: { model: ['2', 0], scheduler: 'simple', steps: STEPS, denoise: 1 } },
    '11': { class_type: 'RandomNoise', inputs: { noise_seed: seed, control_after_generate: 'fixed' } },
    '12': { class_type: 'BasicGuider', inputs: { model: ['2', 0], conditioning: ['8', 0] } },
    '13': { class_type: 'SamplerCustomAdvanced', inputs: { noise: ['11', 0], guider: ['12', 0], sampler: ['9', 0], sigmas: ['10', 0], latent_image: ['8', 1] } },
    '14': { class_type: 'VAEDecode', inputs: { samples: ['13', 1], vae: ['4', 0] } },
    '15': { class_type: 'VAEDecodeAudio', inputs: { samples: ['13', 1], vae: ['5', 0] } },
    '16': { class_type: 'CreateVideo', inputs: { images: ['14', 0], fps: 24, audio: ['15', 0] } },
    '17': { class_type: 'SaveVideo', inputs: { video: ['16', 0], filename_prefix: prefix, format: 'mp4', 'format.codec': 'h264' } },
  };
  if (firstImg) {
    wf['6'] = { class_type: 'LoadImage', inputs: { image: firstImg } };
    wf['8'].inputs.first_frame = ['6', 0];
  }
  if (lastImg) {
    wf['7'] = { class_type: 'LoadImage', inputs: { image: lastImg } };
    wf['8'].inputs.last_frame = ['7', 0];
  }
  return wf;
}

async function comfySubmit(wf) {
  const body = JSON.stringify({ prompt: wf, client_id: 'minimax-shim' });
  const r = await request(COMFY + '/prompt', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: 60000,
  }, body);
  if (!r.json || !r.json.prompt_id) {
    const err = (r.json && (r.json.error || r.json.node_errors)) || r.txt;
    throw new Error('comfy submit failed: ' + JSON.stringify(err).slice(0, 500));
  }
  return r.json.prompt_id;
}

async function comfyHistory(promptId) {
  const r = await request(COMFY + '/history/' + encodeURIComponent(promptId), { timeout: 30000 });
  return r.json && r.json[promptId] ? r.json[promptId] : null;
}

async function comfyView(fileMeta) {
  const q = new URLSearchParams({ filename: fileMeta.filename, subfolder: fileMeta.subfolder || '', type: fileMeta.type || 'output' });
  const r = await request(COMFY + '/view?' + q.toString(), { timeout: 300000 }, null, true);
  if (r.status !== 200 || !r.buf) throw new Error('comfy view failed status=' + r.status);
  return r.buf;
}

// ---------- 任务处理 ----------
function parseContentArray(content) {
  let prompt = '';
  let firstUrl = '', lastUrl = '';
  const refs = [];
  for (const item of content || []) {
    if (!item || typeof item !== 'object') continue;
    if (item.type === 'text') { prompt += (item.text || ''); continue; }
    const url = (item.image_url && item.image_url.url) || (item.video_url && item.video_url.url) || '';
    if (!url) continue;
    if (item.role === 'first_frame') firstUrl = url;
    else if (item.role === 'last_frame') lastUrl = url;
    else refs.push(url);
  }
  return { prompt: prompt.trim(), firstUrl, lastUrl, refs };
}

async function handleGenerate(body) {
  const { prompt, firstUrl, lastUrl } = parseContentArray(body.content);
  if (!prompt) throw new Error('MiniMax H3 requires a text prompt');
  if (lastUrl && !firstUrl) throw new Error('MiniMax H3 last_frame requires first_frame');

  const seconds = parseFloat(body.duration) || 5;
  const length = snapLength(seconds);
  const [width, height] = RATIO_MAP[(body.ratio || '').trim()] || RATIO_MAP['16:9'];

  const taskId = 'shim-' + crypto.randomBytes(8).toString('hex');
  const seed = Math.floor(Math.random() * 4294967295);

  // 下载首尾帧并上传到 ComfyUI input 目录
  let firstImg = null, lastImg = null;
  if (firstUrl) {
    const buf = await download(firstUrl);
    firstImg = await comfyUploadImage(buf, taskId + '_first.png');
    console.log('[shim]', taskId, 'first_frame uploaded ->', firstImg);
  }
  if (lastUrl) {
    const buf = await download(lastUrl);
    lastImg = await comfyUploadImage(buf, taskId + '_last.png');
    console.log('[shim]', taskId, 'last_frame uploaded ->', lastImg);
  }

  const wf = buildWorkflow({
    prompt, width, height, length, seed, firstImg, lastImg,
    prefix: 'huobao/' + taskId,
  });
  const promptId = await comfySubmit(wf);
  tasks.set(taskId, { prompt_id: promptId, status: 'processing', url: null, error: null, created: Date.now() });
  saveState();
  console.log('[shim]', taskId, 'submitted to comfy prompt_id=', promptId, 'len=', length, 'size=', width + 'x' + height, 'seed=', seed);
  return { task_id: taskId, status: 'processing' };
}

async function finalizeTask(taskId, entry) {
  // entry: comfy history record
  const statusStr = entry.status && entry.status.status_str;
  if (statusStr === 'error') {
    const msgs = (entry.status && entry.status.messages) || [];
    let err = 'comfy execution error';
    for (const m of msgs) {
      if (Array.isArray(m) && m[0] === 'execution_error') {
        err = m[1] && (m[1].exception_message || m[1].message) || err;
      }
    }
    tasks.set(taskId, Object.assign(tasks.get(taskId), { status: 'failed', error: String(err).slice(0, 400) }));
    saveState();
    return;
  }
  // 找 SaveVideo 输出
  let fileMeta = null;
  for (const [, out] of Object.entries(entry.outputs || {})) {
    const list = out.gifs || out.videos || out.images || [];
    if (list && list.length) { fileMeta = list[list.length - 1]; break; }
  }
  if (!fileMeta) {
    tasks.set(taskId, Object.assign(tasks.get(taskId), { status: 'failed', error: 'no video output in history' }));
    saveState();
    return;
  }
  const buf = await comfyView(fileMeta);
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, taskId + '.mp4');
  const rawPath = path.join(OUT_DIR, taskId + '_raw.mp4');
  fs.writeFileSync(rawPath, buf);
  // 归一化到 1280x720/30fps/44.1kHz；失败则保留原始文件(降级可用)
  try {
    await normalizeVideo(rawPath, outPath);
    const st = fs.statSync(outPath);
    if (st.size > 0) {
      fs.unlinkSync(rawPath);
      const url = PUBLIC_BASE + '/' + taskId + '.mp4';
      tasks.set(taskId, Object.assign(tasks.get(taskId), { status: 'succeeded', url, file: outPath, size: st.size }));
      saveState();
      console.log('[shim]', taskId, 'DONE(normalized) ->', url, st.size, 'bytes');
      return;
    }
  } catch (e) {
    console.error('[shim]', taskId, 'normalize failed, keep raw:', e.message);
  }
  fs.renameSync(rawPath, outPath);
  const url = PUBLIC_BASE + '/' + taskId + '.mp4';
  tasks.set(taskId, Object.assign(tasks.get(taskId), { status: 'succeeded', url, file: outPath, size: buf.length }));
  saveState();
  console.log('[shim]', taskId, 'DONE(raw) ->', url, buf.length, 'bytes');
}

// 把 H3 原生片段(1344x768/24fps/32kHz)重编码为通用参数，保证与其他镜头可混拼
function normalizeVideo(rawPath, outPath) {
  return new Promise((resolve, reject) => {
    execFile(FFMPEG, [
      '-y', '-i', rawPath,
      '-vf', `scale=${NORM_W}:${NORM_H}:flags=lanczos,fps=${NORM_FPS}`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '23',
      '-c:a', 'aac', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart', outPath,
    ], { timeout: 600000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error('ffmpeg exit ' + err.code + ': ' + String(stderr).slice(-300)));
      resolve();
    });
  });
}

async function handleQuery(taskId) {
  const t = tasks.get(taskId);
  if (!t) return { task: { status: 'failed', error: 'unknown task_id' } };
  if (t.status === 'succeeded') return { task: { status: 'succeeded', content: { url: t.url } } };
  if (t.status === 'failed') return { task: { status: 'failed', error: t.error } };

  // 轮询 comfy history
  try {
    const entry = await comfyHistory(t.prompt_id);
    if (entry) {
      const done = entry.status && (entry.status.completed || entry.status.status_str);
      if (done) {
        await finalizeTask(taskId, entry);
        const nt = tasks.get(taskId);
        if (nt.status === 'succeeded') return { task: { status: 'succeeded', content: { url: nt.url } } };
        return { task: { status: 'failed', error: nt.error } };
      }
    }
  } catch (e) {
    console.error('[shim] query error', taskId, e.message);
  }
  return { task: { status: 'processing' } };
}

// ---------- HTTP 服务 ----------
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://x');
  const send = (code, obj) => {
    const s = JSON.stringify(obj);
    res.writeHead(code, { 'Content-Type': 'application/json' });
    res.end(s);
  };
  try {
    if (req.method === 'GET' && (u.pathname === '/health' || u.pathname === '/')) {
      let ffmpegOk = false;
      try { fs.accessSync(FFMPEG, fs.constants.X_OK); ffmpegOk = true; } catch (e) { /* ignore */ }
      return send(200, { ok: true, tasks: tasks.size, comfy: COMFY, ffmpeg: FFMPEG, ffmpegOk });
    }
    if (req.method === 'POST' && u.pathname === '/v2/video_generation') {
      let body = '';
      req.on('data', (c) => body += c);
      req.on('end', async () => {
        try {
          const parsed = JSON.parse(body || '{}');
          const r = await handleGenerate(parsed);
          send(200, r);
        } catch (e) {
          console.error('[shim] generate error:', e.message);
          send(400, { error: { message: e.message } });
        }
      });
      return;
    }
    const m = u.pathname.match(/^\/v2\/query\/video_generation\/(.+)$/);
    if (req.method === 'GET' && m) {
      const r = await handleQuery(decodeURIComponent(m[1]));
      return send(200, r);
    }
    send(404, { error: { message: 'not found: ' + u.pathname } });
  } catch (e) {
    console.error('[shim] server error:', e);
    send(500, { error: { message: e.message } });
  }
});

loadState();
const handler = server.listeners('request')[0];
// 127.0.0.1: 本机自测; 172.20.0.1: docker 网桥网关(huobao_drama_default), 供容器内 huobao 访问, 不暴露公网
server.listen(PORT, '127.0.0.1', () => {
  console.log('[shim] MiniMax-compatible shim listening on 127.0.0.1:' + PORT);
});
const server2 = http.createServer(handler);
server2.listen(PORT, '172.20.0.1', () => {
  console.log('[shim] MiniMax-compatible shim listening on 172.20.0.1:' + PORT + ' (docker gateway)');
});
console.log('[shim] comfy =', COMFY, '| out =', OUT_DIR, '| unet =', MODEL_UNET);
