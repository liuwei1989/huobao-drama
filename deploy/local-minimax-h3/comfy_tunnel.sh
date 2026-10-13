#!/bin/bash
# comfy_tunnel.sh — 保持到 GPU 盒子 ComfyUI 的 SSH 本地转发
# 用法: comfy_tunnel.sh start|stop|status
LOG=/tmp/tunnel.log
MARK="8188:127.0.0.1:8188"

is_running() {
  pgrep -f "$MARK" > /dev/null 2>&1
}

start() {
  if is_running; then
    echo "tunnel already running (pid: $(pgrep -f "$MARK" | tr '\n' ' '))"
    return 0
  fi
  nohup ssh -i /root/.ssh/id_ed25519 -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o ServerAliveInterval=30 -o ServerAliveCountMax=3 -o ExitOnForwardFailure=yes -N -L 127.0.0.1:8188:127.0.0.1:8188 -p 26096 root@connect.westd.seetacloud.com >> $LOG 2>&1 &
  sleep 5
  if is_running; then
    echo "tunnel started (pid: $(pgrep -f "$MARK" | tr '\n' ' '))"
  else
    echo "tunnel FAILED to start, see $LOG"
    tail -5 $LOG
    return 1
  fi
}

stop() {
  pkill -f "$MARK" 2>/dev/null
  sleep 1
  echo "tunnel stopped"
}

status() {
  if is_running; then
    echo "tunnel RUNNING (pid: $(pgrep -f "$MARK" | tr '\n' ' '))"
    echo "--- comfy system_stats ---"
    curl -s -m 10 http://127.0.0.1:8188/system_stats || echo "(curl failed)"
    echo
  else
    echo "tunnel NOT running"
  fi
}

case "$1" in
  start) start ;;
  stop) stop ;;
  status) status ;;
  restart) stop; start ;;
  *) echo "usage: $0 start|stop|status|restart"; exit 1 ;;
esac
