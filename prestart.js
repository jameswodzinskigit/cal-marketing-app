const fs = require('fs');
const path = require('path');

const serverPath = path.join(__dirname, 'server.js');
const oldOwner = 'chriskraichgit';
const correctOwner = 'jameswodzinskigit';

try {
  const current = fs.readFileSync(serverPath, 'utf8');
  if (current.includes(oldOwner)) {
    fs.writeFileSync(serverPath, current.split(oldOwner).join(correctOwner));
    console.log(`Corrected GitHub repository owner to ${correctOwner}.`);
  }
} catch (error) {
  console.error('Unable to validate GitHub repository owner:', error.message);
  process.exit(1);
}
