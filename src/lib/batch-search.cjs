'use strict';
// Case-insensitive search whose offsets always point into the *original* text,
// even when locale lower-casing changes length ('İ' -> 'i̇', 'ﬁ' -> 'fi'). The
// list filter, the detail offset and the renderer highlight all share this
// module so a row that matches is also the row that can be located.
function foldPiece(char){return char.toLocaleLowerCase();}
function foldText(text){return String(text ?? '').toLocaleLowerCase();}

// Maps folded indices back to original indices. `İ` contributes one folded
// extra character, so a folded index after it is larger than the original one.
//
// A range needs two different mappings, not one. The *start* is the original
// character that contains the first folded unit (floor); the *end* is
// exclusive, so it must be the position just after the character that contains
// the last folded unit (ceil). A single floor mapping plus `max(start+1,mapped)`
// only prevented empty ranges: a match that ended inside an expansion dropped
// the last original character, so `xİ` searched for `xi` highlighted only `x`
// (V4 L-01).
function createFoldIndexer(text){
  const source=String(text ?? '');
  const points=[];let folded=0,index=0;
  for(const char of source){
    const width=foldPiece(char).length;
    if(width!==char.length)points.push({folded,delta:width-char.length});
    folded+=width;index+=char.length;
  }
  const total=index;
  if(!points.length){
    // No expansion: both mappings are the identity, so callers can use
    // start()/end() without special-casing.
    const identity=target=>target;
    identity.start=identity;identity.end=identity;identity.total=total;
    return identity;
  }
  // Cumulative delta of every expansion *before* points[i]. Lookups are
  // stateless (binary search) rather than one shared forward cursor, because
  // start()/end() are asked for the same or a smaller index and a cursor would
  // double-count the shift.
  const before=new Array(points.length);let run=0;
  for(let i=0;i<points.length;i++){before[i]=run;run+=points[i].delta;}
  const lastExpansionBefore=target=>{
    let low=0,high=points.length-1,found=-1;
    while(low<=high){const middle=(low+high)>>1;if(points[middle].folded<target){found=middle;low=middle+1;}else high=middle-1;}
    return found;
  };
  // First original index at or after folded index `target` (floor).
  const start=target=>{
    if(target<=0)return 0;
    const at=lastExpansionBefore(target);
    const shift=at<0?0:before[at]+points[at].delta;
    const original=target-shift;
    return original<0?0:original>total?total:original;
  };
  // Exclusive original end for a folded range ending at `target` (ceil): the
  // original character containing folded unit `target-1` is fully covered.
  const end=target=>{
    if(target<=0)return 0;
    const first=start(target-1);
    if(first>=total)return total;
    const code=source.codePointAt(first);
    const after=first+((code!==undefined&&code>0xffff)?2:1);
    return after>total?total:after;
  };
  const indexer=target=>start(target);
  indexer.start=start;indexer.end=end;indexer.total=total;
  return indexer;
}

function findOffset(text,query,caseSensitive){
  text=String(text ?? '');query=String(query ?? '');
  if(!query)return -1;
  // A case-sensitive search that does not find the exact spelling has *no*
  // match. Falling back to the insensitive index reported a position whose text
  // is not the query, which made the list highlight and the detail jump disagree.
  if(caseSensitive)return text.indexOf(query);
  const needle=foldText(query);
  if(!needle)return -1;
  const hay=foldText(text);
  const at=hay.indexOf(needle);
  if(at<0)return -1;
  return createFoldIndexer(text).start(at);
}

// [start,end) ranges in original coordinates for highlighting, bounded so a
// pathological query cannot build an unbounded DOM.
function foldRanges(text,query,{caseSensitive=false,limit=2000}={}){
  text=String(text ?? '');query=String(query ?? '');
  if(!query)return [];
  const needle=caseSensitive?query:foldText(query);
  if(!needle)return [];
  const hay=caseSensitive?text:foldText(text);
  const indexer=caseSensitive?null:createFoldIndexer(text);
  const ranges=[];let cursor=0;
  while(ranges.length<limit){
    const at=hay.indexOf(needle,cursor);
    if(at<0)break;
    // floor for the first covered character, ceil for the exclusive end. The
    // ceil mapping is what makes an expansion-ending match highlight the whole
    // original range instead of only the ASCII characters before the expansion.
    const start=caseSensitive?at:indexer.start(at);
    const end=caseSensitive?at+needle.length:indexer.end(at+needle.length);
    if(start<0||end<=start)break;
    ranges.push([start,end]);
    cursor=at+needle.length;
    if(cursor<=at)cursor=at+1;
  }
  return ranges;
}

module.exports={findOffset,foldRanges,foldText,createFoldIndexer};
