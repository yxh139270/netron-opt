import * as fs from 'fs';
import * as path from 'path';
import * as playwright from '@playwright/test';
import * as url from 'url';

playwright.test.setTimeout(180000);

playwright.test('viewport-benchmark', async ({ page }) => {
    const self = url.fileURLToPath(import.meta.url);
    const dir = path.dirname(self);
    const file = path.resolve(dir, '../third_party/test/onnx/resnet50.onnx');
    playwright.expect(fs.existsSync(file)).toBeTruthy();

    await page.goto('/');
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('body.welcome', { timeout: 25000 });
    const consent = page.locator('#message-button');
    if (await consent.isVisible({ timeout: 1000 }).catch(() => false)) {
        await consent.click();
    }

    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.locator('.open-file-button, button:has-text("Open Model")').click();
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(file);

    await page.waitForSelector('#canvas', { state: 'attached', timeout: 30000 });
    await page.waitForSelector('body.default', { timeout: 30000 });
    await page.waitForTimeout(2000);

    const metrics = await page.evaluate(async () => {
        const container = document.getElementById('target');
        const samples = [];
        const durationMs = 5000;
        const start = performance.now();
        let last = start;
        const maxScroll = () => Math.max(0, container.scrollHeight - container.clientHeight);
        while (performance.now() - start < durationMs) {
            const now = performance.now();
            samples.push(now - last);
            last = now;
            const phase = ((now - start) / durationMs) * Math.PI;
            const p = (Math.sin(phase) + 1) / 2;
            container.scrollTop = p * maxScroll();
            await new Promise((resolve) => requestAnimationFrame(resolve));
        }
        const nodes = document.querySelectorAll('#nodes > g').length;
        const edges = document.querySelectorAll('#edge-paths > path.edge-path').length;
        const fps = samples.length * 1000 / durationMs;
        const avgFrameMs = samples.reduce((a, b) => a + b, 0) / Math.max(1, samples.length);
        return { fps, avgFrameMs, mountedNodes: nodes, mountedEdges: edges, samples: samples.length };
    });

    const out = path.resolve(dir, '../dist/test/viewport-benchmark.json');
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, JSON.stringify(metrics, null, 2));
    // eslint-disable-next-line no-console
    console.log(`[viewport-benchmark] fps=${metrics.fps.toFixed(2)} avgFrameMs=${metrics.avgFrameMs.toFixed(2)} nodes=${metrics.mountedNodes} edges=${metrics.mountedEdges} samples=${metrics.samples}`);
});
