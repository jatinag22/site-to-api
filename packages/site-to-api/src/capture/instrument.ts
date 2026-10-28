/**
 * The instrumentation injected into every page, and the boundary schema for what it sends back.
 *
 * The page code is kept as plain JavaScript text rather than a compiled function: it runs in the
 * site's realm, so it must not depend on bundler helpers, and its exact text decides the
 * `sourceURL` that lets us drop its own stack frames.
 *
 * Rules the page code follows: every hook is wrapped in try/catch so a failure never reaches the
 * site; wrapped functions keep `this`, arguments, return values, `name`, `length` and their
 * `toString()` output; prototypes and constructors are never replaced, only methods on them; and
 * form field values are never read for `action` events.
 *
 * Every field the page sends is trimmed to {@link LIMITS} in the page and checked against the
 * same limits in {@link pageMessageToEvent}: the binding is reachable by any script in the page,
 * so the Node side cannot rely on the page code having done it.
 *
 * Known limitation: init scripts and bindings do not reach Web Workers or Service Workers, so
 * requests and crypto calls made inside workers have no `request`/`transform` events. Their
 * traffic is still in the HAR, just without an initiator stack.
 */
import type { CaptureEvent } from '../model'
import { z } from 'zod'
import { INSTRUMENT_SOURCE_URL, parseV8Stack } from './stack'

/**
 * Name of the binding the page calls with one JSON string per message; `binding.ts` installs it
 * on `window` through the DevTools protocol.
 */
export const BINDING_NAME = '__siteToApiEmit'

/**
 * Longest message text accepted, in UTF-16 code units: a 2 MB response body plus JSON escaping,
 * which can grow control characters sixfold. Checked before parsing so a page cannot make Node
 * parse an arbitrarily large string.
 */
const MAX_MESSAGE_CHARS = 16 * 1024 * 1024

/**
 * Size limits for what the page sends, in UTF-16 code units for strings and entries for arrays.
 * The page code trims to them; the schema rejects anything larger.
 */
const LIMITS = {
  url: 8192,
  stack: 16_384,
  method: 32,
  bodyPreview: 2048,
  /** Response bodies larger than this (in bytes, so also in characters) are left to the HAR. */
  response: 2_000_000,
  /** A response body still arriving after this long is a stream; stop copying it. */
  responseMs: 30_000,
  mimeType: 256,
  api: 100,
  input: 256,
  /** Longer outputs are dropped, not cut: a truncated digest or ciphertext matches nothing. */
  output: 65_536,
  items: 16,
  detailKeys: 32,
  detailKey: 64,
  label: 200,
  selector: 500,
  field: 200,
} as const

const PAGE_SOURCE = String.raw`
(function () {
  'use strict';
  var BINDING = '__BINDING__';
  var FLAG = '__siteToApiInstrumented';
  try {
    if (window[FLAG]) return;
    Object.defineProperty(window, FLAG, { value: true, enumerable: false });
  } catch (e) { return; }

  var LIMITS = __LIMITS__;
  var BODY_LIMIT = LIMITS.bodyPreview;
  var RESPONSE_LIMIT = LIMITS.response;
  var TEXTUAL = /json|text|xml|javascript|csv|x-www-form-urlencoded/i;
  // Long-lived streams: copying them would buffer the whole stream in page memory, and a cloned
  // body keeps the connection open after the page cancels its own reader.
  var STREAMING = /event-stream|ndjson|stream\+json|multipart\//i;
  var INPUT_LIMIT = LIMITS.input;
  var nativeSetTimeout = window.setTimeout;
  var nativeClearTimeout = window.clearTimeout;
  var stringify = JSON.stringify;
  var queue = [];
  // The binding reaches a popup a moment after its first scripts ran; queued messages are retried
  // for up to ten seconds rather than waiting for the next one to flush them.
  var retryTimer = null;
  var retries = 0;
  var nativeToString = Function.prototype.toString;
  var originals = new WeakMap();
  var apply = Reflect.apply;

  function retry() {
    if (retryTimer !== null || queue.length === 0 || retries >= 100) return;
    retries++;
    try {
      retryTimer = apply(nativeSetTimeout, window, [function () { retryTimer = null; flush(); }, 100]);
    } catch (e) {}
  }

  function flush() {
    var fn;
    try { fn = window[BINDING]; } catch (e) { return; }
    if (typeof fn !== 'function') { retry(); return; }
    while (queue.length > 0) {
      var message = queue.shift();
      try { fn(stringify(message)); } catch (e) {}
    }
  }

  function emit(message) {
    try {
      message.ts = Date.now();
      message.pageUrl = clip(location.href, LIMITS.url);
      if (queue.length < 5000) queue.push(message);
      flush();
    } catch (e) {}
  }

  function stack() {
    try {
      var previous = Error.stackTraceLimit;
      Error.stackTraceLimit = 60;
      var text = String(new Error().stack || '');
      Error.stackTraceLimit = previous;
      return clip(text, LIMITS.stack);
    } catch (e) { return ''; }
  }

  // Wrapped functions report the original source text, so feature checks such as
  // "fetch.toString() includes [native code]" keep giving the same answer.
  try {
    var toStringWrapper = {
      toString() {
        var target = originals.get(this);
        return apply(nativeToString, target === undefined ? this : target, []);
      }
    }.toString;
    originals.set(toStringWrapper, nativeToString);
    Object.defineProperty(Function.prototype, 'toString', {
      value: toStringWrapper, writable: true, configurable: true, enumerable: false
    });
  } catch (e) {}

  function copyShape(wrapper, original) {
    try { Object.defineProperty(wrapper, 'name', { value: original.name, configurable: true }); } catch (e) {}
    try { Object.defineProperty(wrapper, 'length', { value: original.length, configurable: true }); } catch (e) {}
  }

  // Returns makeWrapper(original) with the original's name, length and toString. Method-shorthand
  // functions have no prototype and cannot be called with new, like the native methods they replace.
  function wrapFunction(original, makeWrapper) {
    if (typeof original !== 'function' || originals.has(original)) return original;
    var wrapper = makeWrapper(original);
    copyShape(wrapper, original);
    originals.set(wrapper, original);
    return wrapper;
  }

  // Replaces the method obj[key] with a wrapper, keeping the property's attributes.
  function wrapMethod(obj, key, makeWrapper) {
    try {
      if (!obj) return;
      var desc = Object.getOwnPropertyDescriptor(obj, key);
      if (!desc || typeof desc.value !== 'function') return;
      var wrapper = wrapFunction(desc.value, makeWrapper);
      if (wrapper === desc.value) return;
      Object.defineProperty(obj, key, {
        value: wrapper, writable: desc.writable, configurable: desc.configurable, enumerable: desc.enumerable
      });
    } catch (e) {}
  }

  // Calls patch(value) when obj[key] holds a value now or is assigned one later; when patch
  // returns something, that replaces the value. Libraries load after this script, so globals
  // such as CryptoJS are wrapped on assignment through an accessor.
  function onProperty(obj, key, patch) {
    function run(value) {
      try {
        var replacement = value ? patch(value) : undefined;
        return replacement === undefined ? value : replacement;
      } catch (e) { return value; }
    }
    try {
      var existing = Object.getOwnPropertyDescriptor(obj, key);
      if (existing && 'value' in existing) {
        var replaced = run(existing.value);
        if (replaced !== existing.value && existing.writable) obj[key] = replaced;
        return;
      }
      if (existing) return;
      var current;
      Object.defineProperty(obj, key, {
        configurable: true,
        enumerable: true,
        get() { return current; },
        set(value) { current = run(value); }
      });
    } catch (e) {}
  }

  function clip(text, limit) {
    text = String(text);
    return text.length > limit ? text.slice(0, limit) : text;
  }

  function bytesOf(value) {
    try {
      if (value instanceof ArrayBuffer) return new Uint8Array(value);
      if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    } catch (e) {}
    return null;
  }

  function toBase64(bytes) {
    var binary = '';
    for (var i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
    return nativeBtoa(binary);
  }

  function toHex(bytes) {
    var out = '';
    for (var i = 0; i < bytes.length; i++) out += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
    return out;
  }

  // Text when the bytes are valid UTF-8, base64 otherwise, so previews match how values travel.
  function bytesPreview(bytes, limit) {
    try {
      return clip(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, limit * 4)), limit);
    } catch (e) {
      return clip(toBase64(bytes.subarray(0, limit)), limit);
    }
  }

  function preview(value, limit) {
    try {
      if (value === undefined || value === null) return null;
      if (typeof value === 'string') return clip(value, limit);
      if (typeof URLSearchParams !== 'undefined' && value instanceof URLSearchParams) return clip(value.toString(), limit);
      if (typeof FormData !== 'undefined' && value instanceof FormData) {
        var parts = [];
        value.forEach(function (v, k) {
          parts.push(encodeURIComponent(k) + '=' + (typeof v === 'string' ? encodeURIComponent(v) : '<file>'));
        });
        return clip(parts.join('&'), limit);
      }
      if (typeof Blob !== 'undefined' && value instanceof Blob) return '<blob ' + value.size + ' bytes>';
      var bytes = bytesOf(value);
      if (bytes) return bytesPreview(bytes, limit);
      if (typeof value === 'object' && typeof value.toString === 'function' && value.toString !== Object.prototype.toString) {
        return clip(value.toString(), limit);
      }
      return clip(String(value), limit);
    } catch (e) { return null; }
  }

  function absolute(url) {
    var text;
    try { text = new URL(String(url), location.href).href; } catch (e) { text = String(url); }
    return clip(text, LIMITS.url);
  }

  function methodName(method) {
    return clip(String(method || 'GET').toUpperCase(), LIMITS.method);
  }

  function request(via, method, url, body) {
    emit({ t: 'request', via: via, method: methodName(method), url: absolute(url), bodyPreview: preview(body, BODY_LIMIT), stack: stack() });
  }

  function response(via, method, url, status, mimeType, body) {
    if (typeof body !== 'string' || body.length > RESPONSE_LIMIT) return;
    emit({ t: 'response', via: via, method: methodName(method), url: absolute(url), status: status, mimeType: clip(mimeType, LIMITS.mimeType), body: body });
  }

  function isCopyable(type) {
    return TEXTUAL.test(type) && !STREAMING.test(type);
  }

  // Reads a clone of the body chunk by chunk and gives up, cancelling only the clone, as soon as
  // it passes the size or time limit, so a large or endless body is never buffered whole.
  function readClone(res, done) {
    var body = res.clone().body;
    if (!body) { done(''); return; }
    var reader = body.getReader();
    var chunks = [];
    var size = 0;
    var stopped = false;
    function stop() {
      stopped = true;
      try { reader.cancel().catch(function () {}); } catch (e) {}
    }
    var timer = apply(nativeSetTimeout, window, [stop, LIMITS.responseMs]);
    function pump() {
      reader.read().then(function (step) {
        if (stopped) return;
        if (step.done) {
          apply(nativeClearTimeout, window, [timer]);
          var all = new Uint8Array(size);
          var offset = 0;
          for (var i = 0; i < chunks.length; i++) { all.set(chunks[i], offset); offset += chunks[i].byteLength; }
          done(new TextDecoder().decode(all));
          return;
        }
        size += step.value.byteLength;
        if (size > RESPONSE_LIMIT) { apply(nativeClearTimeout, window, [timer]); stop(); return; }
        chunks.push(step.value);
        pump();
      }, function () { apply(nativeClearTimeout, window, [timer]); });
    }
    pump();
  }

  // Reads a copy of a fetch response so the page's own reading is untouched.
  function fetchResponse(method, url, res) {
    try {
      if (!res || res.type === 'opaque' || res.type === 'opaqueredirect') return;
      var type = (res.headers && res.headers.get('content-type')) || '';
      if (!isCopyable(type)) return;
      var length = Number(res.headers.get('content-length'));
      if (length > RESPONSE_LIMIT) return;
      readClone(res, function (text) {
        try { response('fetch', method, res.url || url, res.status, type, text); } catch (e) {}
      });
    } catch (e) {}
  }

  // Trims a list of strings to the item limit. Over-long entries are cut (inputs) or dropped
  // (outputs, which only help when they match a request value exactly).
  function strings(list, limit, dropLong) {
    var out = [];
    for (var i = 0; i < list.length && out.length < LIMITS.items; i++) {
      var text = String(list[i]);
      if (text.length > limit) {
        if (dropLong) continue;
        text = text.slice(0, limit);
      }
      out.push(text);
    }
    return out;
  }

  function cleanDetails(details) {
    if (!details) return null;
    var out = {};
    var keys = Object.keys(details).slice(0, LIMITS.detailKeys);
    for (var i = 0; i < keys.length; i++) out[clip(keys[i], LIMITS.detailKey)] = clip(details[keys[i]], INPUT_LIMIT);
    return out;
  }

  function transform(api, output, inputs, details, trace) {
    var outputs = strings(output, LIMITS.output, true);
    if (outputs.length === 0) return;
    emit({
      t: 'transform',
      api: clip(api, LIMITS.api),
      output: outputs,
      inputs: strings(inputs, INPUT_LIMIT, false),
      details: cleanDetails(details),
      stack: trace === undefined ? stack() : trace
    });
  }

  var nativeBtoa = window.btoa;

  // fetch
  wrapMethod(window, 'fetch', function (original) {
    return {
      fetch(input, init) {
        var method = 'GET';
        var url = input;
        try {
          if (typeof Request !== 'undefined' && input instanceof Request) { method = input.method; url = input.url; }
          else if (input && typeof input === 'object' && 'href' in input) { url = input.href; }
          if (init && init.method) method = init.method;
          request('fetch', method, url, init ? init.body : null);
        } catch (e) {}
        var result = apply(original, this, arguments);
        try {
          if (result && typeof result.then === 'function')
            result.then(function (res) { fetchResponse(method, url, res); }, function () {});
        } catch (e) {}
        return result;
      }
    }.fetch;
  });

  // XMLHttpRequest: open records method and URL, send reports them with the body.
  var xhrInfo = new WeakMap();
  if (typeof XMLHttpRequest !== 'undefined') {
    wrapMethod(XMLHttpRequest.prototype, 'open', function (original) {
      return {
        open(method, url) {
          try { xhrInfo.set(this, { method: method, url: absolute(url) }); } catch (e) {}
          return apply(original, this, arguments);
        }
      }.open;
    });
    wrapMethod(XMLHttpRequest.prototype, 'send', function (original) {
      return {
        send(body) {
          try {
            var info = xhrInfo.get(this);
            if (info) {
              request('xhr', info.method, info.url, body);
              var xhr = this;
              xhr.addEventListener('load', function () {
                try {
                  var type = xhr.getResponseHeader('content-type') || '';
                  if (!isCopyable(type)) return;
                  var text = xhr.responseType === '' || xhr.responseType === 'text' ? xhr.responseText
                    : xhr.responseType === 'json' ? JSON.stringify(xhr.response) : null;
                  response('xhr', info.method, xhr.responseURL || info.url, xhr.status, type, text);
                } catch (e) {}
              });
            }
          } catch (e) {}
          return apply(original, this, arguments);
        }
      }.send;
    });
  }

  // navigator.sendBeacon
  if (typeof Navigator !== 'undefined') {
    wrapMethod(Navigator.prototype, 'sendBeacon', function (original) {
      return {
        sendBeacon(url, data) {
          try { request('beacon', 'POST', url, data); } catch (e) {}
          return apply(original, this, arguments);
        }
      }.sendBeacon;
    });
  }

  function formBody(form, submitter) {
    try {
      var data = submitter ? new FormData(form, submitter) : new FormData(form);
      if (String(form.method || 'get').toLowerCase() === 'get') return null;
      return data;
    } catch (e) { return null; }
  }

  function formRequest(form, submitter) {
    try {
      var action = (submitter && submitter.getAttribute && submitter.getAttribute('formaction')) || form.getAttribute('action') || location.href;
      var method = (submitter && submitter.getAttribute && submitter.getAttribute('formmethod')) || form.getAttribute('method') || 'GET';
      request('form', method, action, formBody(form, submitter));
    } catch (e) {}
  }

  // form.submit() skips the submit event, so it is hooked directly.
  if (typeof HTMLFormElement !== 'undefined') {
    wrapMethod(HTMLFormElement.prototype, 'submit', function (original) {
      return {
        submit() {
          try { formRequest(this, null); } catch (e) {}
          return apply(original, this, arguments);
        }
      }.submit;
    });
  }

  // btoa
  wrapMethod(window, 'btoa', function (original) {
    return {
      btoa(data) {
        var result = apply(original, this, arguments);
        try { transform('btoa', [String(result)], [clip(String(data), INPUT_LIMIT)], null); } catch (e) {}
        return result;
      }
    }.btoa;
  });

  function algorithmDetails(algorithm) {
    var details = {};
    try {
      if (typeof algorithm === 'string') { details.name = algorithm; return details; }
      if (!algorithm || typeof algorithm !== 'object') return null;
      for (var key in algorithm) {
        var value = algorithm[key];
        if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') details[key] = String(value);
        else if (key === 'hash' && value && typeof value === 'object' && typeof value.name === 'string') details.hash = value.name;
        else if (key === 'public' && value && value.algorithm) details.public = String(value.algorithm.name);
        else {
          var bytes = bytesOf(value);
          if (bytes) details[key] = clip(toBase64(bytes), INPUT_LIMIT);
        }
      }
    } catch (e) {}
    return details;
  }

  // Raw key material each CryptoKey was imported from, so an encrypt or sign call can name the
  // response the key came from (a public key from GET /api/auth/key, for example).
  var keySources = typeof WeakMap !== 'undefined' ? new WeakMap() : null;

  function keyInput(key) {
    try {
      var source = keySources && key && typeof key === 'object' ? keySources.get(key) : null;
      if (source) return source;
      return key && key.algorithm ? clip('<CryptoKey ' + String(key.algorithm.name) + '>', INPUT_LIMIT) : '<key>';
    } catch (e) { return '<key>'; }
  }

  function keyMaterial(format, data) {
    try {
      if (format === 'jwk') return clip(JSON.stringify(data), INPUT_LIMIT);
      var bytes = bytesOf(data);
      return bytes ? clip(toBase64(bytes), INPUT_LIMIT) : null;
    } catch (e) { return null; }
  }

  // crypto.subtle: outputs are recorded when the promise resolves; the site gets the original promise.
  if (typeof SubtleCrypto !== 'undefined') {
    var subtle = SubtleCrypto.prototype;
    var subtleHook = function (name, describeInputs) {
      wrapMethod(subtle, name, function (original) {
        var holder = {
          [name]() {
          var args = arguments;
          var result = apply(original, this, args);
          try {
            var trace = stack();
            Promise.resolve(result).then(function (buffer) {
              try {
                var bytes = bytesOf(buffer);
                if (!bytes) return;
                transform('crypto.subtle.' + name, [toBase64(bytes), toHex(bytes)], describeInputs(args), algorithmDetails(args[0]), trace);
              } catch (e) {}
            }, function () {});
          } catch (e) {}
          return result;
          }
        };
        return holder[name];
      });
    };
    subtleHook('digest', function (args) { return [preview(args[1], INPUT_LIMIT) || '']; });
    subtleHook('encrypt', function (args) { return [keyInput(args[1]), preview(args[2], INPUT_LIMIT) || '']; });
    subtleHook('sign', function (args) { return [keyInput(args[1]), preview(args[2], INPUT_LIMIT) || '']; });
    subtleHook('deriveBits', function (args) { return [keyInput(args[1]), clip(String(args[2]), INPUT_LIMIT)]; });
    if (keySources) {
      wrapMethod(subtle, 'importKey', function (original) {
        return {
          importKey(format, keyData) {
            var result = apply(original, this, arguments);
            try {
              var material = keyMaterial(format, keyData);
              if (material) Promise.resolve(result).then(function (key) { try { keySources.set(key, material); } catch (e) {} }, function () {});
            } catch (e) {}
            return result;
          }
        }.importKey;
      });
    }
  }

  // A top-level function declaration in a classic script replaces the accessor without calling
  // its setter, so library globals are checked again once the document has loaded.
  var globalPatches = [];
  function onGlobal(key, patch) {
    globalPatches.push([key, patch]);
    onProperty(window, key, patch);
  }
  function rescanGlobals() {
    for (var i = 0; i < globalPatches.length; i++) onProperty(window, globalPatches[i][0], globalPatches[i][1]);
  }
  try {
    document.addEventListener('DOMContentLoaded', rescanGlobals, true);
    window.addEventListener('load', rescanGlobals, true);
  } catch (e) {}

  // JSEncrypt
  onGlobal('JSEncrypt', function (JSEncrypt) {
    if (typeof JSEncrypt !== 'function' || !JSEncrypt.prototype) return;
    wrapMethod(JSEncrypt.prototype, 'encrypt', function (original) {
      return {
        encrypt(text) {
          var result = apply(original, this, arguments);
          try {
            if (typeof result === 'string') transform('JSEncrypt.encrypt', [result], [clip(String(text), INPUT_LIMIT)], { name: 'RSA-PKCS1-v1_5' });
          } catch (e) {}
          return result;
        }
      }.encrypt;
    });
  });

  // CryptoJS: components can be added to the CryptoJS object after it is assigned, so each
  // helper is also trapped on that object.
  function wordArrayOutputs(CryptoJS, words) {
    var out = [];
    try { out.push(String(words)); } catch (e) {}
    try { out.push(words.toString(CryptoJS.enc.Base64)); } catch (e) {}
    return out;
  }

  function inputText(value) {
    try { return clip(String(value), INPUT_LIMIT); } catch (e) { return ''; }
  }

  onGlobal('CryptoJS', function (CryptoJS) {
    if (!CryptoJS || typeof CryptoJS !== 'object') return;
    ['HmacSHA256', 'SHA256', 'MD5'].forEach(function (name) {
      onProperty(CryptoJS, name, function (fn) {
        return wrapFunction(fn, function (original) {
          var holder = {
            [name]() {
              var result = apply(original, this, arguments);
              try {
                var inputs = [];
                for (var i = 0; i < arguments.length && i < LIMITS.items; i++) inputs.push(inputText(arguments[i]));
                transform('CryptoJS.' + name, wordArrayOutputs(CryptoJS, result), inputs, { name: name });
              } catch (e) {}
              return result;
            }
          };
          return holder[name];
        });
      });
    });
    onProperty(CryptoJS, 'AES', function (AES) {
      wrapMethod(AES, 'encrypt', function (original) {
        return {
          encrypt(message, key, cfg) {
            var result = apply(original, this, arguments);
            try {
              var output = [];
              try { output.push(String(result)); } catch (e) {}
              if (result && result.ciphertext) output = output.concat(wordArrayOutputs(CryptoJS, result.ciphertext));
              var details = { name: 'AES' };
              try { if (cfg && cfg.mode && cfg.mode.Encryptor) details.mode = String(cfg.mode.name || 'custom'); } catch (e) {}
              transform('CryptoJS.AES.encrypt', output, [inputText(message), inputText(key)], details);
            } catch (e) {}
            return result;
          }
        }.encrypt;
      });
    });
  });

  // Actions. Labels and selectors only; field values are never read.
  function collapse(text, limit) {
    return clip(String(text || '').replace(/\s+/g, ' ').trim(), limit);
  }

  function cssEscape(value) {
    try { return CSS.escape(value); } catch (e) { return String(value).replace(/[^\w-]/g, '\\$&'); }
  }

  function selectorFor(el) {
    try {
      var parts = [];
      var node = el;
      while (node && node.nodeType === 1 && parts.length < 5) {
        if (node.id) { parts.unshift('#' + cssEscape(node.id)); break; }
        var part = node.localName;
        var name = node.getAttribute('name');
        if (name) part += '[name="' + String(name).replace(/"/g, '\\"') + '"]';
        else if (node.parentElement) {
          var index = 1;
          var sibling = node;
          while ((sibling = sibling.previousElementSibling)) if (sibling.localName === node.localName) index++;
          if (index > 1 || (node.nextElementSibling && node.parentElement.querySelectorAll(':scope > ' + node.localName).length > 1)) part += ':nth-of-type(' + index + ')';
        }
        parts.unshift(part);
        node = node.parentElement;
      }
      return parts.join(' > ');
    } catch (e) { return ''; }
  }

  var BUTTON_TYPES = { button: true, submit: true, reset: true, image: true };

  function labelFor(el) {
    try {
      var aria = el.getAttribute('aria-label');
      if (aria) return collapse(aria, 80);
      var isField = el.localName === 'input' || el.localName === 'textarea' || el.localName === 'select';
      if (!isField) {
        var text = collapse(el.innerText, 80);
        if (text) return text;
      }
      if (el.title) return collapse(el.title, 80);
      if (el.localName === 'input' && BUTTON_TYPES[String(el.type).toLowerCase()] && el.value) return collapse(el.value, 80);
      if (isField) {
        if (el.labels && el.labels[0]) return collapse(el.labels[0].innerText, 80);
        if (el.placeholder) return collapse(el.placeholder, 80);
        return collapse(el.name || el.id || el.localName, 80);
      }
      return collapse(el.localName, 80);
    } catch (e) { return ''; }
  }

  var CLICKABLE = 'a,button,input,select,textarea,label,summary,option,[role=button],[role=link],[role=menuitem],[role=tab],[onclick]';

  function action(kind, el, field) {
    emit({ t: 'action', kind: kind, label: labelFor(el), selector: clip(selectorFor(el), LIMITS.selector), field: field === null ? null : clip(field, LIMITS.field) });
  }

  try {
    window.addEventListener('click', function (event) {
      try {
        var target = event.target;
        if (!target || target.nodeType !== 1) return;
        action('click', target.closest(CLICKABLE) || target, null);
      } catch (e) {}
    }, true);

    window.addEventListener('submit', function (event) {
      try {
        var form = event.target;
        if (!form || form.localName !== 'form') return;
        var submitter = event.submitter || null;
        var label = '';
        if (submitter) label = labelFor(submitter);
        emit({ t: 'action', kind: 'submit', label: label || collapse(form.getAttribute('aria-label') || form.name || form.id || 'form', 80), selector: clip(selectorFor(form), LIMITS.selector), field: null });
        formRequest(form, submitter);
      } catch (e) {}
    }, true);

    window.addEventListener('change', function (event) {
      try {
        var target = event.target;
        if (!target || target.nodeType !== 1) return;
        action('change', target, target.name || target.id || null);
      } catch (e) {}
    }, true);
  } catch (e) {}
})();
`

/** Source of the init script, ending with a `sourceURL` so its stack frames can be filtered. */
export function instrumentSource(): string {
  const source = PAGE_SOURCE.replace('__BINDING__', BINDING_NAME).replace('__LIMITS__', JSON.stringify(LIMITS))
  return `${source}\n//# sourceURL=${INSTRUMENT_SOURCE_URL}\n`
}

function text(max: number): z.ZodString {
  return z.string().max(max)
}

const pageBase = {
  ts: z.number(),
  pageUrl: text(LIMITS.url),
}

const stackText = text(LIMITS.stack)

/**
 * What the page sends through the binding. Validated, with the same size limits the page code
 * trims to, because any script in the page can call the binding with whatever it likes.
 */
const PageMessageSchema = z.discriminatedUnion('t', [
  z.object({
    ...pageBase,
    t: z.literal('request'),
    via: z.enum(['fetch', 'xhr', 'beacon', 'form']),
    method: text(LIMITS.method),
    url: text(LIMITS.url),
    bodyPreview: text(LIMITS.bodyPreview).nullable(),
    stack: stackText,
  }),
  z.object({
    ...pageBase,
    t: z.literal('transform'),
    api: text(LIMITS.api),
    output: z.array(text(LIMITS.output)).max(LIMITS.items),
    inputs: z.array(text(LIMITS.input)).max(LIMITS.items),
    details: z.record(text(LIMITS.detailKey), text(LIMITS.input))
      .refine(details => Object.keys(details).length <= LIMITS.detailKeys, `at most ${LIMITS.detailKeys} details`)
      .nullable(),
    stack: stackText,
  }),
  z.object({
    ...pageBase,
    t: z.literal('response'),
    via: z.enum(['fetch', 'xhr']),
    method: text(LIMITS.method),
    url: text(LIMITS.url),
    status: z.number().int(),
    mimeType: text(LIMITS.mimeType),
    body: text(LIMITS.response),
  }),
  z.object({
    ...pageBase,
    t: z.literal('action'),
    kind: z.enum(['click', 'submit', 'change']),
    label: text(LIMITS.label),
    selector: text(LIMITS.selector),
    field: text(LIMITS.field).nullable(),
  }),
])

/**
 * Turns the JSON text the page passed to the binding into a capture event, parsing its stack and
 * recording `frameOrigin`, the security origin of the calling document as the browser reports it
 * (the page cannot forge it). Returns an error message instead of throwing, because a malformed
 * message is a warning, not a reason to stop capturing.
 */
export function pageMessageToEvent(text: string, frameOrigin: string): { event: CaptureEvent } | { error: string } {
  if (text.length > MAX_MESSAGE_CHARS)
    return { error: `message is longer than ${MAX_MESSAGE_CHARS} characters` }
  let payload: unknown
  try {
    payload = JSON.parse(text)
  }
  catch {
    return { error: 'message is not JSON' }
  }
  const parsed = PageMessageSchema.safeParse(payload)
  if (!parsed.success) {
    return {
      error: parsed.error.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`).join('; '),
    }
  }
  const message = parsed.data
  if (message.t === 'action' || message.t === 'response') {
    return {
      event: { ...message, frameOrigin },
    }
  }
  return {
    event: {
      ...message,
      frameOrigin,
      stack: parseV8Stack(message.stack),
    },
  }
}
