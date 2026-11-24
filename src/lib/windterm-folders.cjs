'use strict';
// WindTerm group breadcrumbs use >. Accept older slash/backslash exports too.
function windTermFolder(value) {
  if (typeof value !== 'string') throw new Error('Invalid WindTerm group');
  return value.split(/[\\/>]/).map(part=>part.trim()).filter(Boolean).join('/');
}
module.exports = { windTermFolder };
