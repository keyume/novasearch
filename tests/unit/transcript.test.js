const test = require('node:test');
const assert = require('node:assert/strict');
const { parseTranscript } = require('../../api/_lib/transcript.js');

const VTT = `WEBVTT - sample

NOTE this is a comment
spanning two lines

STYLE
::cue { color: red }

intro
00:00:01.000 --> 00:00:03.000 align:start
<v Alice>Hello and welcome.</v>

00:00:03.200 --> 00:00:06.000
Today we talk
about <i>tides</i>.

00:09.500 --> 00:12.000
First, the moon &amp; more.
`;

const SRT = `1
00:00:01,000 --> 00:00:03,000
Good evening.

2
00:00:03,100 --> 00:00:05,000
This is the news.

3
00:00:10,000 --> 00:00:12,000
In other stories today.
`;

test('VTT：去掉头、注释、样式、时间码、标签，连续字幕合并成段', () => {
  assert.deepEqual(parseTranscript(VTT, 'text/vtt', 'https://t.test/a.vtt'), [
    'Hello and welcome. Today we talk about tides.',
    'First, the moon & more.',
  ]);
});

test('SRT：去掉序号与时间码，按停顿分段', () => {
  assert.deepEqual(parseTranscript(SRT, 'application/x-subrip', 'https://t.test/a.srt'), [
    'Good evening. This is the news.',
    'In other stories today.',
  ]);
});

test('SRT：类型未知时按扩展名识别', () => {
  const out = parseTranscript(SRT, 'application/octet-stream', 'https://t.test/a.srt?x=1');
  assert.equal(out.length, 2);
});

test('字幕：段落超过 400 字符且句子结束时另起一段', () => {
  const cues = Array.from({ length: 12 }, (_, i) => {
    const s = String(i).padStart(2, '0');
    return `00:00:${s}.000 --> 00:00:${s}.900\nThis sentence is exactly fifty characters long, ok ${s}.`;
  }).join('\n\n');
  const out = parseTranscript(`WEBVTT\n\n${cues}`, 'text/vtt', 'https://t.test/a.vtt');
  assert.equal(out.length, 2);
  assert.ok(out[0].length > 400);
  assert.ok(out[0].endsWith('.'));
});

test('HTML：去标签、解实体、script/style 内容丢弃', () => {
  const html =
    '<html><head><style>p{color:red}</style><script>alert("x")</script></head>' +
    '<body><p>Tom &amp; Jerry</p><div>Second&nbsp;para</div><p> </p></body></html>';
  assert.deepEqual(parseTranscript(html, 'text/html; charset=utf-8', 'https://t.test/a'), [
    'Tom & Jerry',
    'Second para',
  ]);
});

test('HTML：br 与数字实体', () => {
  assert.deepEqual(parseTranscript('<p>Line one<br>Line two &#8212; dash &#x41;</p>', 'text/html', ''), [
    'Line one',
    'Line two — dash A',
  ]);
});

test('HTML：类型未知但内容以 < 开头', () => {
  assert.deepEqual(parseTranscript('  <p>Hi</p>', '', 'https://t.test/a'), ['Hi']);
});

test('纯文本：按空行分段，段内换行合并', () => {
  const text = 'First line\ncontinues here.\n\n\nSecond paragraph.\r\n\r\nThird.';
  assert.deepEqual(parseTranscript(text, 'text/plain', 'https://t.test/a.txt'), [
    'First line continues here.',
    'Second paragraph.',
    'Third.',
  ]);
});

test('类型未知时按内容判断 VTT', () => {
  const out = parseTranscript('﻿WEBVTT\n\n00:01.000 --> 00:02.000\nHi there', 'application/octet-stream', 'https://t.test/x');
  assert.deepEqual(out, ['Hi there']);
});

test('空输入返回空数组', () => {
  assert.deepEqual(parseTranscript('', 'text/plain', ''), []);
  assert.deepEqual(parseTranscript('   \n\n ', 'text/vtt', ''), []);
  assert.deepEqual(parseTranscript(undefined, undefined, undefined), []);
});

test('最多 2000 段', () => {
  const text = Array.from({ length: 2500 }, (_, i) => `para ${i}`).join('\n\n');
  assert.equal(parseTranscript(text, 'text/plain', '').length, 2000);
});
