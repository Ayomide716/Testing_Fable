/**
 * The test that would have caught the launch crash.
 *
 * Jest runs on Node, which provides TextEncoder and TextDecoder; Hermes does
 * not. So the suite deletes them first, making the environment behave like the
 * phone. Without that, any accidental reliance on those globals passes here
 * and fails on a real device.
 */

const savedEncoder = (globalThis as Record<string, unknown>).TextEncoder;
const savedDecoder = (globalThis as Record<string, unknown>).TextDecoder;

beforeAll(() => {
  delete (globalThis as Record<string, unknown>).TextEncoder;
  delete (globalThis as Record<string, unknown>).TextDecoder;
});

afterAll(() => {
  (globalThis as Record<string, unknown>).TextEncoder = savedEncoder;
  (globalThis as Record<string, unknown>).TextDecoder = savedDecoder;
});

const SAMPLES = [
  '',
  'plain ascii',
  'café — naïve',
  'клавиатура',
  '🚀 emoji and 👨‍👩‍👧‍👦 a zwj sequence',
  'mixed 日本語 text with \n newlines \t and tabs',
  'a'.repeat(5000),
];

describe('utf8 without the Node globals', () => {
  it('has genuinely removed them', () => {
    expect(typeof (globalThis as Record<string, unknown>).TextEncoder).toBe('undefined');
    expect(typeof (globalThis as Record<string, unknown>).TextDecoder).toBe('undefined');
  });

  it.each(SAMPLES)('round-trips %#', (sample) => {
    const { encodeUtf8, decodeUtf8 } = require('../utf8');
    expect(decodeUtf8(encodeUtf8(sample))).toBe(sample);
  });

  it('matches Node byte-for-byte', () => {
    const { encodeUtf8 } = require('../utf8');
    // Node's own encoder is the reference; it was saved before removal.
    const reference = new (savedEncoder as new () => { encode(s: string): Uint8Array })();
    for (const sample of SAMPLES) {
      expect(Array.from(encodeUtf8(sample))).toEqual(
        Array.from(reference.encode(sample)),
      );
    }
  });

  it('handles malformed input the way Node does', () => {
    const { decodeUtf8 } = require('../utf8');
    // Node's decoder is the oracle rather than a hand-written expectation:
    // guessing these is exactly how the first version got them wrong.
    const reference = new (savedDecoder as new () => { decode(b: Uint8Array): string })();
    const broken = [
      [0xff, 0xfe],             // invalid start bytes
      [0xe2, 0x28],             // bad continuation, must resume at 0x28
      [0xc0, 0x80],             // overlong two-byte form
      [0xe2, 0x82],             // truncated three-byte sequence
      [0xf0, 0x9f, 0x9a],       // truncated emoji
      [0xed, 0xa0, 0x80],       // surrogate half, illegal in utf-8
      [0x41, 0xc3, 0x28, 0x42], // valid, broken, valid
    ];
    for (const bytes of broken) {
      const input = Uint8Array.from(bytes);
      expect(decodeUtf8(input)).toBe(reference.decode(input));
    }
  });

  it('keeps a leading BOM, unlike Node, to match the Python agent', () => {
    const { decodeUtf8, encodeUtf8 } = require('../utf8');
    const bom = Uint8Array.from([0xef, 0xbb, 0xbf, 0x68, 0x69]);
    // Node strips it; Python's bytes.decode("utf-8") does not, and the
    // desktop agent is the other end of the wire.
    expect(decodeUtf8(bom)).toBe('\ufeffhi');
    expect(decodeUtf8(encodeUtf8('\ufeffhi'))).toBe('\ufeffhi');
  });

  it('encrypts and decrypts with the globals absent', () => {
    const { encrypt, decrypt, generateKey } = require('../crypto');
    const key = generateKey();
    const room = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    for (const sample of SAMPLES) {
      expect(decrypt(key, encrypt(key, sample, room), room)).toBe(sample);
    }
  });

  it('the polyfill installs working globals', () => {
    require('../../polyfills');
    const Encoder = (globalThis as Record<string, any>).TextEncoder;
    const Decoder = (globalThis as Record<string, any>).TextDecoder;
    expect(typeof Encoder).toBe('function');
    const bytes = new Encoder().encode('café 🚀');
    expect(new Decoder().decode(bytes)).toBe('café 🚀');
  });
});
