import { TapnowService } from '../src/service.js';
import assert from 'node:assert/strict';
const s = new TapnowService();
try {
  const b=await s.inspect(); assert.equal(b.canvasId,process.env.TAPNOW_TEST_CANVAS_ID); 
  const title='撤销重做验证临时节点-'+Date.now();
  const added=await s.edit({canvasId:b.canvasId,requestId:'history-create-'+Date.now(),operations:[{op:'create',kind:'text',data:{title,text:'Temporary history test'}}]});
  const id=added.results[0].nodeId;
  const deleted=await s.edit({canvasId:b.canvasId,requestId:'history-delete-'+Date.now(),operations:[{op:'delete',nodeIds:[id]}]}); assert.equal(deleted.results[0].ok,true);
  const undo=await s.history({canvasId:b.canvasId,action:'undo'});
  console.log('UNDO_RESULT',JSON.stringify({changed:undo.changed,persistence:undo.persistence}));
  const restored=undo.nodes.find((n:any)=>n.data.title===title);
  assert.ok(restored,'Native undo must restore deleted content (Tapnow may assign a new node ID)');
  const redo=await s.history({canvasId:b.canvasId,action:'redo'}); console.log('REDO_RESULT',JSON.stringify({changed:redo.changed,persistence:redo.persistence})); assert.ok(!redo.nodes.some((n:any)=>n.data.title===title),'Native redo must remove restored content');
  console.log(JSON.stringify({ok:true,nativeUndo:true,nativeRedo:true,persistence:redo.persistence}));
}finally{await s.close();}
