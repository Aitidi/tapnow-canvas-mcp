import { TapnowService } from '../src/service.js';
import { writeFile } from 'node:fs/promises';
const s = new TapnowService();
try {
 const b = await s.inspect();
 const c = await s.generationCapabilities();
 await writeFile('artifacts/video-case-before.json',JSON.stringify(b,null,2));
 await writeFile('artifacts/video-case-capabilities.json',JSON.stringify(c,null,2));
 console.log(JSON.stringify({canvasId:b.canvasId,title:b.title,nodeCount:b.nodes.length,capabilities:c},null,2));
} finally { await s.close(); }
