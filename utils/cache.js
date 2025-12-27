// Simple LRU cache implementation for CSS Inspector
// Prevent duplicate declaration if already loaded via manifest.json

(function() {
  'use strict';
  
  // Check if already loaded
  if (typeof window !== 'undefined' && window.LRUCache) {
    // #region agent log
    fetch('http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'cache.js:8',message:'LRUCache already loaded, skipping',data:{alreadyExists:true},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
    // #endregion
    // Already loaded, skip declaration
    return;
  }
  
  // #region agent log
  fetch('http://127.0.0.1:7242/ingest/f39900fe-c8d4-4476-a6da-eb8eed4bf005',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({location:'cache.js:15',message:'Declaring LRUCache',data:{alreadyExists:false},timestamp:Date.now(),sessionId:'debug-session',runId:'run1',hypothesisId:'E'})}).catch(()=>{});
  // #endregion

  class LRUCache {
    constructor(maxSize = 100) {
      this.maxSize = maxSize;
      this.cache = new Map();
    }

    get(key) {
      if (this.cache.has(key)) {
        // Move to end (most recently used)
        const value = this.cache.get(key);
        this.cache.delete(key);
        this.cache.set(key, value);
        return value;
      }
      return null;
    }

    set(key, value) {
      if (this.cache.has(key)) {
        // Update existing
        this.cache.delete(key);
      } else if (this.cache.size >= this.maxSize) {
        // Remove least recently used (first item)
        const firstKey = this.cache.keys().next().value;
        this.cache.delete(firstKey);
      }
      this.cache.set(key, value);
    }

    clear() {
      this.cache.clear();
    }

    has(key) {
      return this.cache.has(key);
    }
  }

  // Debounce utility
  function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
      const later = () => {
        clearTimeout(timeout);
        func(...args);
      };
      clearTimeout(timeout);
      timeout = setTimeout(later, wait);
    };
  }

  // Throttle utility
  function throttle(func, limit) {
    let inThrottle;
    return function executedFunction(...args) {
      if (!inThrottle) {
        func.apply(this, args);
        inThrottle = true;
        setTimeout(() => (inThrottle = false), limit);
      }
    };
  }

  // Expose to global scope for Chrome extension content scripts
  if (typeof window !== 'undefined') {
    window.LRUCache = LRUCache;
    window.debounce = debounce;
    window.throttle = throttle;
  }
})();
