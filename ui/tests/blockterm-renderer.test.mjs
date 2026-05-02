import assert from "node:assert/strict";
import test from "node:test";
import createDOMPurify from "dompurify";
import { JSDOM } from "jsdom";

import {
  MAX_MUSTACHE_RENDERED_BYTES,
  MAX_MUSTACHE_TEMPLATE_BYTES,
  parseBlockTermMustacheVariables,
  renderBlockTermMustache,
} from "../src/components/terminal/blockterm-mustache.ts";

import {
  parseBlockTermCsv,
  parseBlockTermRendererCommand,
  parseBlockTermRendererState,
  resolveBlockTermRendererPath,
  resolveRendererRelativeResource,
} from "../src/components/terminal/blockterm-renderer.ts";
import {
  BLOCKTERM_RENDERER_NAMES,
  BLOCKTERM_RENDERER_SELECTIONS,
  blockTermRendererRegistry,
  isBlockTermRendererSelection,
  resolveBlockTermRendererSwitch,
} from "../src/components/terminal/blockterm-renderer-registry.ts";
import {
  canCreateBlockTermRawView,
  detectBlockTermRawRendererMimeType,
  getBlockTermRendererTextByteLimit,
  isBlockTermRendererTextSizeAllowed,
  resolveBlockTermRawRendererPayload,
} from "../src/components/terminal/blockterm-renderer-raw.ts";
import {
  canControlBlockTermModelStream,
  nextBlockTermModelReconnectDelay,
  parseBlockTermModelSSEFrame,
  shouldRetryBlockTermModelStream,
  splitBlockTermModelSSE,
} from "../src/components/terminal/blockterm-model-stream.ts";
import { blockTermModelNameFitsLimit } from "../src/components/terminal/blockterm-model-limits.ts";

function concatBytes(...parts) {
  return Uint8Array.from(Buffer.concat(parts.map((part) => Buffer.from(part))));
}

function textBytes(value) {
  return new TextEncoder().encode(value);
}

function isoBmffBox(type, ...payloadParts) {
  const payload = Buffer.concat(payloadParts.map((part) => Buffer.from(part)));
  const box = Buffer.alloc(8 + payload.length);
  box.writeUInt32BE(box.length, 0);
  box.write(type, 4, 4, "ascii");
  payload.copy(box, 8);
  return Uint8Array.from(box);
}

function isoBmffFixture(handlerTypes, majorBrand = "isom", extraBoxes = [], compatibleBrand = "mp42") {
  const ftyp = isoBmffBox("ftyp", textBytes(majorBrand), new Uint8Array(4), textBytes(compatibleBrand));
  const tracks = handlerTypes.map((handlerType) =>
    isoBmffBox(
      "trak",
      isoBmffBox("mdia", isoBmffBox("hdlr", new Uint8Array(8), textBytes(handlerType), new Uint8Array(4)))
    )
  );
  return concatBytes(ftyp, isoBmffBox("moov", ...tracks), ...extraBoxes);
}

function ebmlElement(id, ...payloadParts) {
  const payload = concatBytes(...payloadParts);
  assert.ok(payload.length < 127);
  return concatBytes(id, Uint8Array.of(0x80 | payload.length), payload);
}

function ebmlFixture(docType, trackTypes = []) {
  const header = ebmlElement([0x1a, 0x45, 0xdf, 0xa3], ebmlElement([0x42, 0x82], textBytes(docType)));
  const tracks = ebmlElement(
    [0x16, 0x54, 0xae, 0x6b],
    ...trackTypes.map((trackType) => ebmlElement([0xae], ebmlElement([0x83], Uint8Array.of(trackType))))
  );
  return concatBytes(header, ebmlElement([0x18, 0x53, 0x80, 0x67], tracks));
}

function oggBosPage(packet) {
  assert.ok(packet.length < 255);
  const header = new Uint8Array(28);
  header.set(textBytes("OggS"));
  header[5] = 0x02;
  header[26] = 1;
  header[27] = packet.length;
  return concatBytes(header, packet);
}

function applyOnlcrFrame(payload) {
  const output = [];
  for (const byte of concatBytes(Uint8Array.of(0x0a), payload, Uint8Array.of(0x0a))) {
    if (byte === 0x0a) output.push(0x0d);
    output.push(byte);
  }
  return Uint8Array.from(output);
}

test("resolves command renderer switches to PTY-backed state", () => {
  assert.deepEqual(BLOCKTERM_RENDERER_NAMES, ["code", "markdown", "csv", "image", "pdf", "media", "mustache", "openai"]);
  assert.deepEqual(BLOCKTERM_RENDERER_SELECTIONS, [
    "terminal",
    "code",
    "markdown",
    "csv",
    "image",
    "pdf",
    "media",
    "mustache",
    "none",
  ]);
  for (const renderer of BLOCKTERM_RENDERER_NAMES.filter((name) => name !== "openai")) {
    assert.deepEqual(resolveBlockTermRendererSwitch({ kind: "command" }, renderer), {
      ok: true,
      patch: { renderer, stateJson: '{"prompt:source":"pty"}' },
    });
  }
  assert.deepEqual(resolveBlockTermRendererSwitch({ kind: "command" }, "terminal"), {
    ok: true,
    patch: { renderer: "terminal", stateJson: "" },
  });
  assert.deepEqual(resolveBlockTermRendererSwitch({ kind: "command" }, "none"), {
    ok: true,
    patch: { renderer: "none", stateJson: "" },
  });
  assert.deepEqual(resolveBlockTermRendererSwitch({ kind: "note" }, "terminal"), {
    ok: false,
    reason: "unsupported-kind",
  });
  assert.deepEqual(resolveBlockTermRendererSwitch({ kind: "command" }, "openai"), {
    ok: false,
    reason: "unknown-renderer",
  });
  assert.deepEqual(resolveBlockTermRendererSwitch({ kind: "renderer" }, "terminal"), {
    ok: false,
    reason: "unsupported-kind",
  });
  assert.deepEqual(resolveBlockTermRendererSwitch({ kind: "command" }, "legacy-unknown"), {
    ok: false,
    reason: "unknown-renderer",
  });
  assert.equal(isBlockTermRendererSelection("terminal"), true);
  assert.equal(isBlockTermRendererSelection("none"), true);
  assert.equal(isBlockTermRendererSelection("openai"), false);
  assert.equal(isBlockTermRendererSelection("legacy-unknown"), false);
});

test("parses chat and openai aliases as model-backed renderer", () => {
  const chat = parseBlockTermRendererCommand("/chat model=gpt-4o Explain this output");
  assert.equal(chat.kind, "renderer");
  assert.equal(chat.renderer, "openai");
  assert.equal(chat.output, "Explain this output");
  assert.deepEqual(JSON.parse(chat.stateJson), { "prompt:source": "model", model: "gpt-4o" });
  assert.equal(parseBlockTermRendererCommand("openai hello").renderer, "openai");
  assert.equal(parseBlockTermRendererCommand("chat Explain model=gpt-4o this output").output, "Explain this output");
  assert.equal(parseBlockTermRendererCommand("chat compare x=1 with y=2").output, "compare x=1 with y=2");
  assert.equal(parseBlockTermRendererCommand('chat "model=gpt-4o" literally').output, "model=gpt-4o literally");
  assert.deepEqual(parseBlockTermRendererState("openai", chat.stateJson, "/tmp"), {
    renderer: "openai",
    source: "model",
    filePath: "",
    mode: "view",
    model: "gpt-4o",
  });
  assert.deepEqual(
    parseBlockTermRendererState(
      "openai",
      JSON.stringify({ "prompt:source": "model", model: "gpt-4o", error: "provider rejected the request" }),
      "/tmp"
    ),
    {
      renderer: "openai",
      source: "model",
      filePath: "",
      mode: "view",
      model: "gpt-4o",
      error: "provider rejected the request",
    }
  );
  assert.equal(blockTermModelNameFitsLimit("a".repeat(256)), true);
  assert.equal(blockTermModelNameFitsLimit("a".repeat(257)), false);
  assert.equal(blockTermModelNameFitsLimit("界".repeat(85)), true);
  assert.equal(blockTermModelNameFitsLimit("界".repeat(86)), false);
  assert.equal(
    parseBlockTermRendererState("openai", JSON.stringify({ "prompt:source": "model", model: "界".repeat(86) }), "/tmp"),
    null
  );
});

test("parses fragmented model SSE frames and terminal events", () => {
  const first = splitBlockTermModelSSE('data: {"seq":1,"delta":"hel"}\r\n\r\ndata: {"seq":2');
  assert.equal(first.frames.length, 1);
  assert.equal(first.pending, 'data: {"seq":2');
  assert.deepEqual(parseBlockTermModelSSEFrame(first.frames[0]), { seq: 1, delta: "hel" });

  const second = splitBlockTermModelSSE(`${first.pending},"text":"hello"}\n\ndata: [DONE]\n\n`);
  assert.deepEqual(second.frames.map(parseBlockTermModelSSEFrame), [
    { seq: 2, text: "hello" },
    { done: true, status: "success" },
  ]);
  assert.equal(second.pending, "");
  assert.deepEqual(parseBlockTermModelSSEFrame("data: not-json"), {
    error: "model stream returned invalid event data",
  });
  assert.deepEqual(parseBlockTermModelSSEFrame('data: {"delta":"  "}'), { delta: "  " });
  assert.deepEqual(parseBlockTermModelSSEFrame('data: {"delta":"\\n"}'), { delta: "\n" });
  assert.equal(shouldRetryBlockTermModelStream(401), false);
  assert.equal(shouldRetryBlockTermModelStream(404), false);
  assert.equal(shouldRetryBlockTermModelStream(429), true);
  assert.equal(shouldRetryBlockTermModelStream(503), true);
  assert.equal(canControlBlockTermModelStream("streaming", false), true);
  assert.equal(canControlBlockTermModelStream("streaming", true), false);
  assert.equal(canControlBlockTermModelStream("error", false), false);
  assert.equal(nextBlockTermModelReconnectDelay(250), 500);
  assert.equal(nextBlockTermModelReconnectDelay(4000), 4000);
});

test("creates raw resource views only for recognized passive formats", () => {
  const png = Uint8Array.from(
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4xkAAAAASUVORK5CYII=", "base64")
  );
  const pdf = new TextEncoder().encode("%PDF-1.7\n");
  const svg = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>');
  assert.equal(detectBlockTermRawRendererMimeType("image", png), "image/png");
  assert.equal(canCreateBlockTermRawView("image", "image/png"), true);
  assert.equal(detectBlockTermRawRendererMimeType("pdf", pdf), "application/pdf");
  assert.equal(canCreateBlockTermRawView("pdf", "application/pdf"), true);
  assert.equal(detectBlockTermRawRendererMimeType("image", svg), "application/octet-stream");
  assert.equal(canCreateBlockTermRawView("image", "image/svg+xml"), false);
  assert.equal(canCreateBlockTermRawView("image", "application/octet-stream"), false);
  assert.equal(canCreateBlockTermRawView("media", "application/octet-stream"), false);
});

test("keeps modern binary payloads unchanged and reverses legacy PTY ONLCR framing", () => {
  const png = Uint8Array.from(
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Z4xkAAAAASUVORK5CYII=", "base64")
  );
  const pdf = textBytes("%PDF-1.7\n1 0 obj\r\n<<>>\nendobj\n");
  const media = isoBmffFixture(["soun"], "isom", [isoBmffBox("free", Uint8Array.of(0x0d, 0x0a, 0x0a))]);
  for (const [renderer, bytes, mimeType] of [
    ["image", png, "image/png"],
    ["pdf", pdf, "application/pdf"],
    ["media", media, "audio/mp4"],
  ]) {
    const modern = resolveBlockTermRawRendererPayload(renderer, bytes);
    assert.equal(modern.mimeType, mimeType);
    assert.strictEqual(modern.bytes, bytes);

    const legacy = resolveBlockTermRawRendererPayload(renderer, applyOnlcrFrame(bytes));
    assert.equal(legacy.mimeType, mimeType);
    assert.deepEqual(legacy.bytes, bytes);
  }

  const trailingCrPdf = textBytes("%PDF-1.7\r");
  assert.deepEqual(resolveBlockTermRawRendererPayload("pdf", applyOnlcrFrame(trailingCrPdf)).bytes, trailingCrPdf);
});

test("classifies ISO-BMFF from track handlers instead of brands", () => {
  const audioMp4 = isoBmffFixture(["soun"]);
  const videoMp4 = isoBmffFixture(["soun", "vide"]);
  const brandsOnly = isoBmffBox("ftyp", textBytes("isom"), new Uint8Array(4), textBytes("mp42"));
  const audioBrandOnly = isoBmffBox("ftyp", textBytes("M4A "), new Uint8Array(4), textBytes("isom"));
  const unknownBrand = isoBmffFixture(["soun"], "evil", [], "bad!");

  assert.equal(detectBlockTermRawRendererMimeType("media", audioMp4), "audio/mp4");
  assert.equal(detectBlockTermRawRendererMimeType("media", videoMp4), "video/mp4");
  assert.equal(detectBlockTermRawRendererMimeType("media", brandsOnly), "application/octet-stream");
  assert.equal(detectBlockTermRawRendererMimeType("media", audioBrandOnly), "application/octet-stream");
  assert.equal(detectBlockTermRawRendererMimeType("media", unknownBrand), "application/octet-stream");
  assert.equal(detectBlockTermRawRendererMimeType("media", audioMp4.subarray(0, 16)), "application/octet-stream");
});

test("requires Ogg codec or EBML track evidence before classifying containers", () => {
  assert.equal(detectBlockTermRawRendererMimeType("media", oggBosPage(textBytes("OpusHead"))), "audio/ogg");
  assert.equal(
    detectBlockTermRawRendererMimeType("media", oggBosPage(concatBytes(Uint8Array.of(0x80), textBytes("theora")))),
    "video/ogg"
  );
  assert.equal(detectBlockTermRawRendererMimeType("media", oggBosPage(textBytes("unknown"))), "application/octet-stream");
  assert.equal(detectBlockTermRawRendererMimeType("media", textBytes("OggS")), "application/octet-stream");

  assert.equal(detectBlockTermRawRendererMimeType("media", ebmlFixture("webm", [2])), "audio/webm");
  assert.equal(detectBlockTermRawRendererMimeType("media", ebmlFixture("webm", [2, 1])), "video/webm");
  assert.equal(detectBlockTermRawRendererMimeType("media", ebmlFixture("matroska", [1])), "video/x-matroska");
  assert.equal(detectBlockTermRawRendererMimeType("media", ebmlFixture("webm")), "application/octet-stream");
  assert.equal(
    detectBlockTermRawRendererMimeType(
      "media",
      Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 0x87, 0x42, 0x82, 0x84, 0x77, 0x65, 0x62, 0x6d])
    ),
    "application/octet-stream"
  );
});

test("distinguishes complete AAC ADTS and MP3 frame headers", () => {
  const aac = new Uint8Array(309);
  aac.set([0xff, 0xf1, 0x50, 0x40, 0x26, 0xbf, 0xfc]);
  const mp3 = new Uint8Array(417);
  mp3.set([0xff, 0xfb, 0x90, 0x64]);
  const id3Mp3 = concatBytes(textBytes("ID3"), Uint8Array.of(4, 0, 0, 0, 0, 0, 0), mp3);

  assert.equal(detectBlockTermRawRendererMimeType("media", aac), "audio/aac");
  assert.equal(detectBlockTermRawRendererMimeType("media", mp3), "audio/mpeg");
  assert.equal(detectBlockTermRawRendererMimeType("media", id3Mp3), "audio/mpeg");
  assert.equal(
    detectBlockTermRawRendererMimeType("media", Uint8Array.of(0xff, 0xe0, 0x00, 0x00)),
    "application/octet-stream"
  );
  assert.equal(
    detectBlockTermRawRendererMimeType("media", Uint8Array.of(0xff, 0xf1, 0x50, 0x40, 0x26, 0xbf, 0xfc)),
    "application/octet-stream"
  );
});

test("applies file renderer byte limits to PTY text sources", () => {
  const limits = {
    code: 10 * 1024 * 1024,
    markdown: 200_000,
    csv: 10 * 1024 * 1024,
    mustache: MAX_MUSTACHE_TEMPLATE_BYTES,
  };
  for (const [renderer, limit] of Object.entries(limits)) {
    assert.equal(getBlockTermRendererTextByteLimit(renderer), limit);
    assert.equal(isBlockTermRendererTextSizeAllowed(renderer, limit), true);
    assert.equal(isBlockTermRendererTextSizeAllowed(renderer, limit + 1), false);
  }
  assert.equal(getBlockTermRendererTextByteLimit("image"), null);
  assert.equal(isBlockTermRendererTextSizeAllowed("image", 16 * 1024 * 1024), true);
});
test("looks up renderer definitions and resolves command aliases through the registry", () => {
  assert.deepEqual(BLOCKTERM_RENDERER_NAMES, [
    "code",
    "markdown",
    "csv",
    "image",
    "pdf",
    "media",
    "mustache",
    "openai",
  ]);
  assert.equal(blockTermRendererRegistry.get("markdown")?.name, "markdown");

  const alias = blockTermRendererRegistry.resolveCommand("mdview");
  assert.equal(alias?.renderer.name, "markdown");
  assert.equal(alias?.command.name, "markdownview");
  assert.equal(alias?.matchedName, "mdview");
  assert.equal(alias?.isAlias, true);

  const canonical = blockTermRendererRegistry.resolveCommand("markdownview");
  assert.equal(canonical?.command.name, "markdownview");
  assert.equal(canonical?.isAlias, false);
});

test("returns null for unknown renderers, commands, and host dispatch entries", () => {
  assert.equal(blockTermRendererRegistry.get("unknown"), null);
  assert.equal(blockTermRendererRegistry.get("terminal"), null);
  assert.equal(blockTermRendererRegistry.resolveCommand("unknownview"), null);

  const dispatch = blockTermRendererRegistry.createDispatch(
    Object.fromEntries(BLOCKTERM_RENDERER_NAMES.map((name) => [name, `${name}-handler`]))
  );
  assert.equal(dispatch.resolve("code")?.handler, "code-handler");
  assert.equal(dispatch.resolve("unknown"), null);
});

test("maps WaveTerm renderer commands without sending them to the shell", () => {
  const cases = [
    ["codeedit file.go", "code", "edit"],
    ["/codeview file.go", "code", "view"],
    ["csvview data.csv", "csv", undefined],
    ["imageview plot.png", "image", undefined],
    ["mdview README.md", "markdown", undefined],
    ["/markdownview README.md", "markdown", undefined],
    ["pdfview report.pdf", "pdf", undefined],
    ["mediaview demo.mp4", "media", undefined],
    ["mustacheview report.mustache", "mustache", undefined],
    ["/mustache report.mustache", "mustache", undefined],
  ];
  for (const [command, renderer, mode] of cases) {
    const result = parseBlockTermRendererCommand(command);
    assert.equal(result.kind, "renderer", command);
    assert.equal(result.renderer, renderer, command);
    const state = JSON.parse(result.stateJson);
    if (renderer === "media") assert.equal(state["prompt:source"], undefined, command);
    else assert.equal(state["prompt:source"], "file", command);
    if (mode) assert.equal(state.mode, mode, command);
  }
  assert.equal(parseBlockTermRendererCommand("printf codeview").kind, "none");
  assert.equal(parseBlockTermRendererCommand("codeviewer file.go").kind, "none");
});

test("parses local Mustache templates and state_json variables", () => {
  const result = parseBlockTermRendererCommand(
    `mustacheview templates/report.html state_json='{"title":"Build","items":[{"name":"UI"},{"name":"API"}]}'`
  );
  assert.equal(result.kind, "renderer");
  assert.equal(result.commandName, "mustacheview");
  assert.equal(result.renderer, "mustache");
  assert.equal(result.output, 'mustacheview "templates/report.html"');
  assert.deepEqual(JSON.parse(result.stateJson), {
    "prompt:source": "file",
    "prompt:file": "templates/report.html",
    variables: {
      title: "Build",
      items: [{ name: "UI" }, { name: "API" }],
    },
  });

  const bracket = parseBlockTermRendererCommand(
    `[template="templates/a]b.html" state_json='{"title":"A]B"}'] /mustache`
  );
  assert.equal(bracket.kind, "renderer");
  assert.deepEqual(JSON.parse(bracket.stateJson), {
    "prompt:source": "file",
    "prompt:file": "templates/a]b.html",
    variables: { title: "A]B" },
  });

  const positional = parseBlockTermRendererCommand(`mustache report.html '{"name":"VibeGo"}'`);
  assert.equal(positional.kind, "renderer");
  assert.deepEqual(JSON.parse(positional.stateJson).variables, { name: "VibeGo" });
});

test("rejects unsafe or oversized Mustache state_json", () => {
  for (const source of [
    "[]",
    "null",
    "not-json",
    '{"__proto__":{"polluted":true}}',
    '{"hasOwnProperty":"shadowed"}',
  ]) {
    const result = parseBlockTermRendererCommand(`mustacheview report.html state_json='${source}'`);
    assert.equal(result.kind, "error", source);
    assert.match(result.message, /state_json/, source);
  }

  let nested = {};
  for (let index = 0; index < 18; index += 1) nested = { value: nested };
  const nestedResult = parseBlockTermMustacheVariables(JSON.stringify(nested));
  assert.equal(nestedResult.ok, false);
  assert.match(nestedResult.error, /nesting/);

  const unicodeResult = parseBlockTermMustacheVariables(JSON.stringify({ value: "界".repeat(1_400) }));
  assert.equal(unicodeResult.ok, false);
  assert.match(unicodeResult.error, /too large/);
});

test("renders Mustache variables while removing dangerous HTML and all resource URLs", () => {
  const dom = new JSDOM("");
  const purifier = createDOMPurify(dom.window);
  const rendered = renderBlockTermMustache(
    [
      "<h1>{{title}}</h1>",
      "{{#items}}<p title=\"{{name}}\">{{name}}</p>{{/items}}",
      "<div>{{{unsafe}}}</div>",
      '<img src="https://example.com/tracker.png" onerror="alert(1)">',
      '<a href="https://example.com/">external</a>',
      '<iframe src="https://example.com/"></iframe>',
      '<style>@import "https://example.com/style.css";</style>',
    ].join(""),
    {
      title: "Build <script>alert(1)</script>",
      items: [{ name: "UI" }, { name: "API" }],
      unsafe: '<script>alert(1)</script><p style="background:url(https://example.com/a)" onclick="alert(1)">safe</p>',
    },
    purifier
  );
  const document = new JSDOM(`<body>${rendered}</body>`).window.document;
  assert.equal(document.querySelector("h1")?.textContent, "Build <script>alert(1)</script>");
  assert.deepEqual(
    [...document.querySelectorAll("p")].map((node) => node.textContent),
    ["UI", "API", "safe"]
  );
  assert.equal(document.querySelectorAll("script,img,iframe,style,svg,object,embed,form").length, 0);
  assert.equal(document.querySelectorAll("[src],[href],[style],[onerror],[onclick]").length, 0);
});

test("bounds Mustache template and rendered output sizes", () => {
  const dom = new JSDOM("");
  const purifier = createDOMPurify(dom.window);
  assert.throws(
    () => renderBlockTermMustache("x".repeat(MAX_MUSTACHE_TEMPLATE_BYTES + 1), {}, purifier),
    /template is too large/
  );
  assert.throws(() => renderBlockTermMustache("   ", {}, purifier), /template is blank/);
  assert.throws(() => renderBlockTermMustache("{{#missing}", {}, purifier), /Unclosed tag/);
  const repeated = "x".repeat(Math.ceil(MAX_MUSTACHE_RENDERED_BYTES / 60) + 1);
  assert.throws(
    () => renderBlockTermMustache(`{{#items}}${repeated}{{/items}}`, { items: Array(60).fill(true) }, purifier),
    /output is too large/
  );
});

test("parses WaveTerm bracket kwargs and quoted file paths", () => {
  const result = parseBlockTermRendererCommand('[lang=typescript minimap=0] codeedit "src/a=b file.ts" ignored.ts');
  assert.equal(result.kind, "renderer");
  assert.equal(result.commandName, "codeedit");
  assert.equal(result.output, 'codeedit "src/a=b file.ts"');
  assert.deepEqual(JSON.parse(result.stateJson), {
    "prompt:source": "file",
    "prompt:file": "src/a=b file.ts",
    mode: "edit",
    lang: "typescript",
    minimap: false,
  });

  const alias = parseBlockTermRendererCommand("mdview README.md");
  assert.equal(alias.kind, "renderer");
  assert.equal(alias.commandName, "markdownview");
  const explicitAlias = parseBlockTermRendererCommand("/mdview README.md");
  assert.equal(explicitAlias.kind, "renderer");
  assert.equal(explicitAlias.commandName, "mdview");

  const inline = parseBlockTermRendererCommand('codeedit src/main.ts lang="typescript" minimap="false"');
  assert.equal(inline.kind, "renderer");
  assert.deepEqual(JSON.parse(inline.stateJson), {
    "prompt:source": "file",
    "prompt:file": "src/main.ts",
    mode: "edit",
    lang: "typescript",
    minimap: false,
  });
});

test("returns static errors for invalid renderer meta commands", () => {
  const missing = parseBlockTermRendererCommand("codeview");
  assert.equal(missing.kind, "error");
  assert.match(missing.message, /requires an argument/);

  const unquotedEquals = parseBlockTermRendererCommand("codeview a=b.txt");
  assert.equal(unquotedEquals.kind, "error");

  const operator = parseBlockTermRendererCommand("codeview README.md; rm -rf target");
  assert.equal(operator.kind, "error");
  assert.match(operator.message, /operators/);

  assert.equal(parseBlockTermRendererCommand("codeview\tREADME.md").kind, "none");

  const invalidSubcommand = parseBlockTermRendererCommand("/codeview:bad README.md");
  assert.equal(invalidSubcommand.kind, "error");
  assert.equal(invalidSubcommand.message, "invalid /codeview subcommand 'bad'");
});

test("follows WaveTerm Bash word comments and empty expansion semantics", () => {
  const comment = parseBlockTermRendererCommand("codeview README.md # ignored");
  assert.equal(comment.kind, "renderer");
  assert.equal(JSON.parse(comment.stateJson)["prompt:file"], "README.md");

  const expansion = parseBlockTermRendererCommand("codeview prefix-$UNSET.md");
  assert.equal(expansion.kind, "renderer");
  assert.equal(JSON.parse(expansion.stateJson)["prompt:file"], "prefix-.md");

  const commandSubstitution = parseBlockTermRendererCommand("codeview prefix-$(printf ignored).md");
  assert.equal(commandSubstitution.kind, "renderer");
  assert.equal(JSON.parse(commandSubstitution.stateJson)["prompt:file"], "prefix-.md");
});

test("resolves renderer files against the block cwd", () => {
  assert.equal(resolveBlockTermRendererPath("/work/project/src", "../README.md"), "/work/project/README.md");
  assert.equal(resolveBlockTermRendererPath("C:\\work\\project", "docs\\guide.md"), "C:/work/project/docs/guide.md");
  assert.equal(resolveBlockTermRendererPath("/ignored", "/tmp/file.txt"), "/tmp/file.txt");
  assert.equal(resolveBlockTermRendererPath("/", "README.md"), "/README.md");
  assert.equal(resolveBlockTermRendererPath("/work/project", "~/notes/today.md"), "~/notes/today.md");
  assert.equal(resolveBlockTermRendererPath("/work/project", "notes:today.md"), "/work/project/notes:today.md");
  assert.equal(resolveBlockTermRendererPath("/work/project", "https://example.com/file.md"), "https://example.com/file.md");
});

test("validates persisted renderer state and falls back for unknown or damaged values", () => {
  assert.deepEqual(
    parseBlockTermRendererState(
      "code",
      JSON.stringify({ "prompt:source": "file", "prompt:file": "src/main.ts", mode: "edit", lang: "typescript" }),
      "/work/project"
    ),
    {
      renderer: "code",
      filePath: "/work/project/src/main.ts",
      mode: "edit",
      lang: "typescript",
      minimap: undefined,
    }
  );
  assert.deepEqual(
    parseBlockTermRendererState(
      "mustache",
      JSON.stringify({
        "prompt:source": "file",
        "prompt:file": "templates/report.html",
        variables: { title: "Build", rows: [{ value: 1 }] },
      }),
      "/work/project"
    ),
    {
      renderer: "mustache",
      filePath: "/work/project/templates/report.html",
      mode: "view",
      lang: undefined,
      minimap: undefined,
      variables: { title: "Build", rows: [{ value: 1 }] },
    }
  );
  assert.equal(
    parseBlockTermRendererState(
      "mustache",
      JSON.stringify({ "prompt:source": "file", "prompt:file": "https://example.com/report.html", variables: {} }),
      "/work/project"
    ),
    null
  );
  assert.equal(parseBlockTermRendererState("unknown", "{}", "/work"), null);
  assert.equal(parseBlockTermRendererState("markdown", "not-json", "/work"), null);
  assert.deepEqual(parseBlockTermRendererState("markdown", "{}", "/work"), {
    renderer: "markdown",
    source: "pty",
    filePath: "",
    mode: "view",
    lang: undefined,
    minimap: undefined,
  });
  assert.deepEqual(parseBlockTermRendererState("code", JSON.stringify({ "prompt:source": "pty" }), "/work"), {
    renderer: "code",
    source: "pty",
    filePath: "",
    mode: "view",
    lang: undefined,
    minimap: undefined,
  });
  assert.deepEqual(parseBlockTermRendererState("csv", "", "/work"), {
    renderer: "csv",
    source: "pty",
    filePath: "",
    mode: "view",
    lang: undefined,
    minimap: undefined,
  });
  assert.equal(
    parseBlockTermRendererState(
      "markdown",
      JSON.stringify({ "prompt:source": "pty", "prompt:file": "README.md" }),
      "/work"
    ),
    null
  );
  assert.equal(
    parseBlockTermRendererState("markdown", JSON.stringify({ "prompt:source": "stdout" }), "/work"),
    null
  );
  assert.equal(
    parseBlockTermRendererState(
      "markdown",
      JSON.stringify({ "prompt:source": "file", "prompt:file": "notes:today.md" }),
      "/work/project"
    )?.filePath,
    "/work/project/notes:today.md"
  );

  assert.deepEqual(
    parseBlockTermRendererState(
      "media",
      JSON.stringify({ "prompt:file": "~/Videos/demo.mp4" }),
      "/work/project"
    ),
    {
      renderer: "media",
      filePath: "~/Videos/demo.mp4",
      mode: "view",
      lang: undefined,
      minimap: undefined,
    }
  );
});

test("keeps markdown local resources in the rendered file directory", () => {
  assert.equal(resolveRendererRelativeResource("/work/docs/README.md", "./assets/plot.png"), "/work/docs/assets/plot.png");
  assert.equal(resolveRendererRelativeResource("/work/docs/README.md", "https://example.com/image.png"), null);
  assert.equal(resolveRendererRelativeResource("/work/docs/README.md", "javascript:alert(1)"), null);
  assert.equal(resolveRendererRelativeResource("/work/docs/README.md", "#section"), "#section");
});

test("parses quoted CSV newlines and makes duplicate headers unique", () => {
  assert.deepEqual(parseBlockTermCsv('name,notes\nalpha,"line one\nline two"\n'), {
    columns: ["name", "notes"],
    rows: [["alpha", "line one\nline two"]],
    totalRows: 1,
    truncated: false,
  });

  assert.deepEqual(parseBlockTermCsv("name,name,\nalpha,beta,gamma\n"), {
    columns: ["name", "name_2", "Column 3"],
    rows: [["alpha", "beta", "gamma"]],
    totalRows: 1,
    truncated: false,
  });
});

test("truncates CSV rows and columns at renderer limits", () => {
  const rowLimited = parseBlockTermCsv(`value\n${Array.from({ length: 5_001 }, (_, index) => index).join("\n")}`);
  assert.equal(rowLimited.rows.length, 5_000);
  assert.equal(rowLimited.totalRows, 5_001);
  assert.equal(rowLimited.truncated, true);

  const columns = Array.from({ length: 201 }, (_, index) => `column-${index + 1}`);
  const columnLimited = parseBlockTermCsv(`${columns.join(",")}\n${columns.join(",")}`);
  assert.equal(columnLimited.columns.length, 200);
  assert.equal(columnLimited.rows[0].length, 200);
  assert.equal(columnLimited.truncated, true);
});
