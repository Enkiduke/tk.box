import test from 'node:test';
import assert from 'node:assert/strict';
import {catalogWindow,catalogPages} from '../apps/web/src/catalog-window.js';

test('large catalogs keep a bounded visible window and load direct jump pages without walking prior pages',()=>{
  const initial=catalogWindow(100000,6,320,0,900);
  assert.equal(initial.firstRow,0);assert.equal(initial.endRow,6);
  const jump=catalogWindow(100000,6,320,320*1000,900);
  assert.equal(jump.visibleIndex,6000);assert.equal(jump.endRow-jump.firstRow,9);
  assert.deepEqual(catalogPages(jump.firstRow*6,jump.endRow*6,100000),[5940,6000]);
  assert.equal(catalogWindow(405,6,300,300*67,900).endRow,68);
  assert.deepEqual(catalogPages(402,420,405),[360]);
  assert.deepEqual(catalogPages(0,60,0),[]);
});
