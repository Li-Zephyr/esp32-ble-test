/* Original minimum-test protocol. UTF-8 bytes are decoded only after complete reassembly. */
(function (root) {
  'use strict';
  const FRAME = 20, HEADER = 8, PAYLOAD = 12, MAX_TEXT = 256;
  const encoder = new TextEncoder();
  function encode(text, id, type = 1) {
    const bytes = encoder.encode(text);
    if (!Number.isInteger(id) || id < 1 || id > 65535) throw new Error('消息编号无效');
    if (!bytes.length || bytes.length > MAX_TEXT) throw new Error('请输入1–256字节的UTF-8文字');
    const count = Math.ceil(bytes.length / PAYLOAD), frames = [];
    for (let index = 0; index < count; index++) {
      const part = bytes.subarray(index * PAYLOAD, (index + 1) * PAYLOAD);
      const f = new Uint8Array(HEADER + part.length), v = new DataView(f.buffer);
      f[0] = 1; f[1] = type; v.setUint16(2, id, true); f[4] = index; f[5] = count;
      v.setUint16(6, bytes.length, true); f.set(part, HEADER); frames.push(f);
    }
    return frames;
  }
  class Receiver {
    constructor() { this.reset(); }
    reset() { this.message = null; }
    accept(input) {
      try {
        const f = input instanceof Uint8Array ? input : new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
        if (f.length <= HEADER || f.length > FRAME || f[0] !== 1 || ![1, 2, 3].includes(f[1])) throw new Error('帧版本、类型或长度错误');
        const view = new DataView(f.buffer, f.byteOffset, f.byteLength);
        const id = view.getUint16(2, true), total = view.getUint16(6, true), index = f[4], count = f[5];
        if (!id || !total || total > MAX_TEXT || count !== Math.ceil(total / PAYLOAD) || index >= count ||
            f.length !== HEADER + Math.min(PAYLOAD, total - index * PAYLOAD)) throw new Error('分包头错误');
        if (index === 0) {
          if (this.message) throw new Error('上一条尚未完成');
          this.message = { id, type: f[1], total, next: 0, bytes: new Uint8Array(total) };
        }
        const m = this.message;
        if (!m || m.id !== id || m.total !== total || m.type !== f[1] || m.next !== index) throw new Error('分包缺失、乱序或消息不一致');
        m.bytes.set(f.subarray(HEADER), index * PAYLOAD); m.next++;
        if (m.next !== count) return null;
        this.reset();
        return { id, type: m.type, text: new TextDecoder('utf-8', { fatal: true }).decode(m.bytes), byteLength: total };
      } catch (e) { this.reset(); throw e; }
    }
  }
  root.VoiceProtocol = { FRAME, HEADER, PAYLOAD, MAX_TEXT, encode, Receiver };
})(globalThis);
