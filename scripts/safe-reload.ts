import type { TapnowService } from '../src/service.js';

/** Reload only after a confirmed native save; dismiss ("Stay") any unsaved-changes dialog instead of hanging. */
export async function safeReload(service: TapnowService, canvasId: string, expectedNodes?: number) {
  const saved = await service.save({ canvasId });
  if (saved.persistence?.confirmed !== true) throw new Error('Refusing to reload: save not confirmed ' + JSON.stringify(saved.persistence));
  await service.cdp.send('Page.enable');
  await new Promise(r => setTimeout(r, 1000));
  const again = await service.save({ canvasId });
  if (again.persistence?.confirmed !== true) throw new Error("Refusing to reload: second save not confirmed");
  const reload = service.cdp.send('Page.reload', {}, 5000).catch(() => null);
  await new Promise(r => setTimeout(r, 1500));
  const blocked = await service.cdp.send('Page.handleJavaScriptDialog', { accept: false }, 3000).then(() => true, () => false);
  await reload;
  if (blocked) throw new Error('Unsaved-changes dialog appeared after a confirmed save; stayed on page');
  let state: any;
  for (let i = 0; i < 40; i++) {
    await new Promise(r => setTimeout(r, 500));
    try { state = await service.inspect(); if (expectedNodes === undefined ? i >= 6 : state.nodes.length === expectedNodes) break; } catch {}
  }
  return state;
}

/** Drop-in for a raw Page.reload in live scripts: refuses to reload unless the native save is confirmed. */
export async function guardedReload(service: TapnowService, canvasId = process.env.TAPNOW_TEST_CANVAS_ID!) {
  for (let i = 0; i < 2; i++) {
    const saved = await service.save({ canvasId });
    if (saved.persistence?.confirmed !== true) throw new Error('Refusing to reload: save not confirmed ' + JSON.stringify(saved.persistence));
    await new Promise(r => setTimeout(r, 1000));
  }
  await service.cdp.send('Page.reload');
}
