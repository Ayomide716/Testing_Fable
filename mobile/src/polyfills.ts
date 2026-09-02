/**
 * Runtime gaps this app has to fill before anything else loads.
 *
 * Hermes has no TextEncoder or TextDecoder, and React Native does not
 * polyfill them. Our own code avoids them entirely (see lib/utf8.ts), but
 * dependencies may reach for them, and a ReferenceError thrown while a module
 * is being imported closes a release build instantly with no error screen.
 *
 * Import this first, before any other module, in App.tsx.
 */

import { decodeUtf8, encodeUtf8 } from './lib/utf8';

// Cast through `unknown`: the DOM lib types these globals with members the
// shim has no use for (fatal, ignoreBOM, stream decoding), and the app only
// ever needs whole-buffer UTF-8.
const target = globalThis as unknown as Record<string, unknown>;

if (typeof target.TextEncoder === 'undefined') {
  target.TextEncoder = class {
    readonly encoding = 'utf-8';

    encode(input = ''): Uint8Array {
      return encodeUtf8(input);
    }

    encodeInto(input: string, destination: Uint8Array) {
      const bytes = encodeUtf8(input);
      const written = Math.min(bytes.length, destination.length);
      destination.set(bytes.subarray(0, written));
      return { read: input.length, written };
    }
  };
}

if (typeof target.TextDecoder === 'undefined') {
  target.TextDecoder = class {
    readonly encoding: string;

    constructor(encoding = 'utf-8') {
      const normalised = encoding.toLowerCase();
      if (normalised !== 'utf-8' && normalised !== 'utf8') {
        throw new RangeError(`only utf-8 is supported, got "${encoding}"`);
      }
      this.encoding = 'utf-8';
    }

    decode(input?: ArrayBuffer | ArrayBufferView): string {
      if (!input) return '';
      const bytes =
        input instanceof Uint8Array
          ? input
          : ArrayBuffer.isView(input)
            ? new Uint8Array(input.buffer, input.byteOffset, input.byteLength)
            : new Uint8Array(input);
      return decodeUtf8(bytes);
    }
  };
}

export {};
