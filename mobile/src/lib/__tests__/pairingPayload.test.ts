import { parsePairingPayload, InvalidPairingError } from '../pairingPayload';
import vectors from '../../../../tests/vectors.json';

const valid = {
  v: 1,
  room: vectors.room_id,
  key: vectors.key_b64,
  code: 'a'.repeat(32),
  url: 'https://abcdefgh.supabase.co',
  anon: 'anon-key',
  name: 'workstation (Linux)',
};

const encode = (patch: Record<string, unknown>) =>
  JSON.stringify({ ...valid, ...patch });

describe('parsePairingPayload', () => {
  it('accepts a well-formed payload and trims the url', () => {
    const parsed = parsePairingPayload(encode({ url: 'https://abcdefgh.supabase.co/' }));
    expect(parsed.roomId).toBe(vectors.room_id);
    expect(parsed.supabaseUrl).toBe('https://abcdefgh.supabase.co');
    expect(parsed.deviceName).toBe('workstation (Linux)');
  });

  it.each([
    ['not json at all', 'https://example.com'],
    ['a future version', encode({ v: 2 })],
    ['a malformed room id', encode({ room: 'nope' })],
    ['a short key', encode({ key: 'c2hvcnQ=' })],
    ['a short join code', encode({ code: 'abc' })],
    ['a plaintext http url', encode({ url: 'http://abcdefgh.supabase.co' })],
    ['a missing anon key', encode({ anon: '' })],
  ])('rejects %s', (_label, raw) => {
    expect(() => parsePairingPayload(raw as string)).toThrow(InvalidPairingError);
  });
});
