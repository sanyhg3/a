const { chromium } = require('playwright');
const path = require('path');

const USER_DATA_DIR = path.join(__dirname, 'saved_browser_profile');

(async () => {
  console.log('🌐 Opening your saved profile for manual setup...');
  console.log('💡 Close the physical browser window when you are finished.');

  const context = await chromium.launchPersistentContext(USER_DATA_DIR, {
    headless: false, 
    viewport: null, // This forces it to open as a normal, resizable desktop window!
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  // Automatically kills this script when you hit the 'X' on the browser window
  context.on('close', () => {
    console.log('✅ Browser closed safely. You can restart your main server now.');
    process.exit(0);
  });
})();
