'use strict';
const SERVICE = '71e10000-6f69-4f63-9c82-3d66e3e09a01';
const WRITE = '71e10001-6f69-4f63-9c82-3d66e3e09a01';
const NOTIFY = '71e10002-6f69-4f63-9c82-3d66e3e09a01';
const $ = id => document.getElementById(id);
const P = globalThis.VoiceProtocol;
let device = null, writer = null, notifier = null, ready = false, busy = false;
let nextId = 1, pending = null, generation = 0;
let operation = 0;
const decoder = new P.Receiver();
const lines = [];
function log(text) { lines.push(new Date().toISOString() + ' ' + text); if (lines.length > 100) lines.shift(); $('log').textContent = lines.join('\n'); }
function status(text) { $('status').textContent = text; }
function refresh() { $('connect').disabled = busy || ready || !isSecureContext || !navigator.bluetooth; $('send').disabled = !ready || busy; $('disconnect').disabled = !session; }
function countBytes() { $('bytes').textContent = `${new TextEncoder().encode($('text').value).length} / ${P.MAX_TEXT} 字节`; }
function deadline(promise, ms, label) {
  let timer; return Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(label + '超时')), ms); })]).finally(() => clearTimeout(timer));
}
let session = null;
const gattOwners = new WeakMap();
function live(s) { return session === s && s.ticket === generation; }
function requireLive(s) { if (!live(s)) throw new Error('连接已取消'); }
function disconnectOwned(s) {
  const gatt = s.device?.gatt;
  // A newer attempt may own the exact same BluetoothRemoteGATTServer object.
  if (gatt && gattOwners.get(gatt) === s) gatt.disconnect();
}
function cleanup(reason) {
  const old = session;
  session = null; // Invalidate callbacks before disconnect can dispatch synchronously.
  ++generation; ++operation; busy = false; ready = false;
  if (pending) { const item = pending; pending = null; clearTimeout(item.timer); item.reject(new Error(reason)); }
  if (old?.notifier) old.notifier.removeEventListener('characteristicvaluechanged', old.onNotify);
  if (old?.device) old.device.removeEventListener('gattserverdisconnected', old.onLost);
  if (old) disconnectOwned(old);
  device = writer = notifier = null; decoder.reset(); nextId = 1;
  status(reason); refresh();
}
function received(event) {
  try {
    const v = event.target.value;
    const frame = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
    const result = decoder.accept(frame);
    if (!result) return;
    if (!pending || result.id !== pending.id) { log('忽略过期/无对应请求的通知 id=' + result.id); return; }
    if (result.type !== 2 && result.type !== 3) throw new Error('设备回复类型不正确');
    const item = pending; pending = null; clearTimeout(item.timer);
    if (result.type === 3) item.reject(new Error('设备错误：' + result.text));
    else { log(`RX id=${result.id} bytes=${result.byteLength}`); item.resolve(result.text); }
  } catch (e) { log('通知错误：' + e.message); cleanup('回复无效，请重新连接'); }
}
$('connect').onclick = async () => {
  if (busy || ready) return;
  const owner = ++operation;
  const s = { ticket: ++generation, device: null, notifier: null };
  session = s;
  busy = true; refresh(); status('请选择 ESP32-Voice-Test，并允许蓝牙访问');
  try {
    // requestDevice stays directly in the click handler (no preceding await).
    const chosen = await navigator.bluetooth.requestDevice({ filters: [{ services: [SERVICE] }] });
    requireLive(s);
    s.device = chosen; device = chosen;
    gattOwners.set(chosen.gatt, s);
    s.onLost = event => {
      if (!live(s) || (event?.target && event.target !== chosen)) return;
      log('BLE断开'); cleanup('已断开，请重新连接');
    };
    chosen.addEventListener('gattserverdisconnected', s.onLost); refresh();
    const connecting = chosen.gatt.connect();
    // Promise.race cannot cancel a native connect. Clean up a late success only
    // if this attempt still owns that GATT object; never tear down a new owner.
    Promise.resolve(connecting).then(() => { if (!live(s)) disconnectOwned(s); }, () => {});
    const gatt = await deadline(connecting, 15000, 'GATT连接'); requireLive(s);
    const service = await deadline(gatt.getPrimaryService(SERVICE), 10000, '服务发现'); requireLive(s);
    const localWriter = await deadline(service.getCharacteristic(WRITE), 10000, '写特征发现'); requireLive(s);
    const localNotifier = await deadline(service.getCharacteristic(NOTIFY), 10000, '通知特征发现'); requireLive(s);
    s.notifier = localNotifier;
    s.onNotify = event => {
      if (!live(s)) return;
      received(event);
    };
    localNotifier.addEventListener('characteristicvaluechanged', s.onNotify);
    await deadline(localNotifier.startNotifications(), 10000, '通知订阅'); requireLive(s);
    writer = localWriter; notifier = localNotifier;
    ready = true; status('已连接并订阅，可以发送'); log('READY name=' + (chosen.name || '(桥接未提供名称)'));
  } catch (e) {
    if (live(s)) { log(`${e.name}: ${e.message}`); cleanup('连接未完成：' + e.message); }
    // A stale attempt owns no global state. No chosen !== device disconnect.
  } finally { if (owner === operation) { busy = false; refresh(); } }
};
$('disconnect').onclick = () => cleanup('已手动断开');
$('send').onclick = async () => {
  if (!ready || busy) return;
  let frames;
  try { frames = P.encode($('text').value, nextId); } catch (e) { status(e.message); return; }
  if (nextId >= 65535) { cleanup('编号将耗尽，请重新连接'); return; }
  const id = nextId++, ticket = generation, owner = ++operation;
  busy = true; refresh(); $('reply').textContent = '等待设备回复…'; status('发送中…');
  const response = new Promise((resolve, reject) => {
    pending = { id, resolve, reject, timer: null };
  });
  // Attach immediately so an early disconnect does not create an unhandled rejection.
  response.catch(() => {});
  try {
    log(`TX id=${id} bytes=${new TextEncoder().encode($('text').value).length} frames=${frames.length}`);
    for (const frame of frames) {
      if (!ready || ticket !== generation) throw new Error('连接已改变');
      const op = typeof writer.writeValueWithResponse === 'function'
        ? writer.writeValueWithResponse(frame) : writer.writeValue(frame);
      await deadline(op, 8000, '分片写入');
    }
    // Start the reply deadline only after the final write completes. Early replies remain valid.
    if (pending?.id === id && ticket === generation) pending.timer = setTimeout(() => {
      if (pending?.id === id && ticket === generation) {
        const item = pending; pending = null; item.reject(new Error('等待回复超时（12秒）'));
      }
    }, 12000);
    const reply = await response;
    if (ticket !== generation) throw new Error('连接已改变');
    $('reply').textContent = reply;
    status(reply === '收到' ? '已收到设备回复；请对照串口核对原文是否完整' : '设备返回了其他文字');
  } catch (e) { if (ticket === generation) { log('发送失败：' + e.message); $('reply').textContent = '未确认成功'; cleanup('发送未确认，请重新连接后再试'); } }
  finally { if (owner === operation) { busy = false; refresh(); } }
};
$('boundary').onclick = () => { $('text').value = '中文跨包测试：你好，ESP32😀；中文不能被截断。'; countBytes(); };
$('text').addEventListener('input', countBytes);
log('secureContext=' + isSecureContext + ' bluetooth=' + Boolean(navigator.bluetooth));
status(!isSecureContext ? '需要可信HTTPS页面，当前环境不安全' : !navigator.bluetooth ? '未检测到Web Bluetooth，请在BLE Link内打开' : '环境接口存在，请点击连接（尚未测试设备）');
countBytes(); refresh();
