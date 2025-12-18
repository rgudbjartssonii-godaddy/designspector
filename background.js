// Background service worker
chrome.action.onClicked.addListener((tab) => {
  console.log('[CSS Inspector] Extension icon clicked, tab ID:', tab.id);
  
  // Function to send toggle message with retry
  const sendToggleMessage = (retryCount = 0) => {
    const maxRetries = 3;
    console.log('[CSS Inspector] Sending togglePanel message to tab:', tab.id, 'retry:', retryCount);
    
    chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' }, (response) => {
      if (chrome.runtime.lastError) {
        console.log('[CSS Inspector] Content script not loaded, injecting...', chrome.runtime.lastError.message);
        
        // Inject both JS and CSS (with dependencies)
        Promise.all([
          chrome.scripting.executeScript({
            target: { tabId: tab.id },
            files: ['utils/cache.js', 'utils/colorUtils.js', 'content.js']
          }),
          chrome.scripting.insertCSS({
            target: { tabId: tab.id },
            files: ['content.css']
          })
        ]).then(() => {
          console.log('[CSS Inspector] Content script and CSS injected, waiting for initialization...');
          // Wait longer for initialization, especially for complex pages
          return new Promise(resolve => setTimeout(resolve, 500));
        }).then(() => {
          console.log('[CSS Inspector] Sending togglePanel message after injection...');
          // Send the toggle message again
          chrome.tabs.sendMessage(tab.id, { action: 'togglePanel' }, (response) => {
            if (chrome.runtime.lastError) {
              if (retryCount < maxRetries) {
                console.log('[CSS Inspector] Retrying...', retryCount + 1);
                setTimeout(() => sendToggleMessage(retryCount + 1), 200);
              } else {
                console.error('[CSS Inspector] Error toggling panel after injection:', chrome.runtime.lastError.message);
              }
            } else {
              console.log('[CSS Inspector] Toggle message sent successfully, response:', response);
            }
          });
        }).catch(err => {
          console.error('[CSS Inspector] Error injecting script:', err);
          if (err.message && err.message.includes('Cannot access')) {
            // CSP restriction - try to show user-friendly error
            chrome.scripting.executeScript({
              target: { tabId: tab.id },
              func: () => {
                alert('Designspector cannot run on this page due to Content Security Policy restrictions.');
              }
            }).catch(() => {});
          }
        });
      } else {
        console.log('[CSS Inspector] Toggle message sent successfully (content script already loaded), response:', response);
      }
    });
  };
  
  // Always try to send the message
  sendToggleMessage();
});
