// Генерирует PNG-иконки из SVG. Запуск: node tools/make-icons.mjs
// Нужен Playwright с Chromium.
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const bubble = (scale) => {
  // Пузырь с буквой «Ā»; scale < 1 — для maskable/iPhone (рисунок в безопасной зоне).
  const t = `translate(256 256) scale(${scale}) translate(-256 -256)`;
  return `<g transform="${t}">
    <path d="M150 120h212a60 60 0 0 1 60 60v120a60 60 0 0 1-60 60H236l-86 70v-70a60 60 0 0 1-60-60V180a60 60 0 0 1 60-60z" fill="#fff"/>
    <text x="256" y="318" text-anchor="middle" font-family="DejaVu Sans, Arial, sans-serif" font-weight="700" font-size="190" fill="#9E3039">Ā</text>
  </g>`;
};
const svg = (rounded, scale) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="512" height="512">
  <rect width="512" height="512" ${rounded ? 'rx="112"' : ''} fill="#9E3039"/>${bubble(scale)}</svg>`;

const jobs = [
  ['icons/icon-192.png', 192, svg(true, 1)],
  ['icons/icon-512.png', 512, svg(true, 1)],
  ['icons/maskable-512.png', 512, svg(false, 0.78)],
  ['icons/apple-touch-icon.png', 180, svg(false, 0.9)],
];

const browser = await chromium.launch();
const page = await browser.newPage();
for (const [file, size, s] of jobs) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<html><body style="margin:0;background:transparent">
    <div style="width:${size}px;height:${size}px">${s.replace('width="512" height="512"', `width="${size}" height="${size}"`)}</div></body></html>`);
  await page.locator('div').screenshot({ path: file, omitBackground: true });
  console.log('ok', file);
}
await browser.close();
