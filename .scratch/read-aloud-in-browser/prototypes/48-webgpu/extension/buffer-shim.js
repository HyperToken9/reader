// PROTOTYPE 48: just enough of Node's Buffer for engine.js loadVoices() (the .npz reader).
export class Buffer extends Uint8Array {
  static from(bytes) {
    const u = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
    return new Buffer(u.buffer, u.byteOffset, u.byteLength);
  }
  get dv() { return new DataView(this.buffer, this.byteOffset, this.byteLength); }
  readUInt32LE(o) { return this.dv.getUint32(o, true); }
  readUInt16LE(o) { return this.dv.getUint16(o, true); }
  readBigUInt64LE(o) { return this.dv.getBigUint64(o, true); }
  toString(enc, a = 0, b = this.length) {
    const s = new Uint8Array(this.buffer, this.byteOffset + a, b - a);
    return enc === "latin1" ? String.fromCharCode(...s) : new TextDecoder().decode(s);
  }
}
