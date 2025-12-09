// Background service worker
chrome.action.onClicked.addListener((tab) => {
  console.log('[CSS Inspector] Extension icon clicked, tab ID:', tab.id);
  
  // Function to send toggle message
  const sendToggleMessage = () => {
    console.log('[CSS Inspector] Sending togglePanel message to tab:', tab.id);
    chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('[CSS Inspector] Content script not loaded, injecting...', chrome.runtime.lastError.message);
        // Content script might not be loaded yet, inject it first
        chrome.scripting.executeScript({
          target: { tabId: tab.id },
          files: ['content.js']
        }).then(() => {
          console.log('[CSS Inspector] Content script injected, waiting for initialization...');
          // Wait for script to initialize - message listener setup should be synchronous,
          // but give it a moment to ensure everything is ready
          return new Promise(resolve => setTimeout(resolve, 150));
        }).then(() => {
          console.log('[CSS Inspector] Sending togglePanel message after injection...');
          // Send the toggle message again
          chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' }, (response) => {
            if (chrome.runtime.lastError) {
              console.error('[CSS Inspector] Error toggling panel after injection:', chrome.runtime.lastError.message);
            } else {
              console.log('[CSS Inspector] Toggle message sent successfully, response:', response);
            }
          });
        }).catch(err => {
          console.error('[CSS Inspector] Error injecting script:', err);
        });
      } else {
        console.log('[CSS Inspector] Toggle message sent successfully (content script already loaded), response:', response);
      }
    });
  };
  
  // Always try to send the message
  sendToggleMessage();
});
