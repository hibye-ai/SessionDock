'use strict';
const fs=require('node:fs'),path=require('node:path'),s=require('../scripts/release-integrity.cjs');
function writeArchiveManifest(zip,version,buildID='synthetic-only'){fs.writeFileSync(path.join(path.dirname(zip),s.MANIFEST_FILE),s.manifestBytes(s.createManifest({zip,version,buildID})));}
module.exports={writeArchiveManifest};
