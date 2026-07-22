/**
 * HVAC AI — Embeddable Chat Widget
 *
 * Single-file widget (no build step). Drop into any page:
 *
 *   <script>
 *     window.HVAC_AI_CONFIG = { baseUrl: 'https://your-hvac-ai.com' };
 *   </script>
 *   <script src="/widget.js" defer></script>
 *
 * Or use the hosted version:
 *   <script src="https://your-hvac-ai.com/widget.js" defer></script>
 *
 * Configuration options (set on window.HVAC_AI_CONFIG before loading):
 *   baseUrl       — HVAC AI server base URL (default: same origin)
 *   sessionId     — stable session ID (default: auto-generated UUID)
 *   company       — company name (overrides server config)
 *   accentColor   — primary color (CSS value, e.g. '#1a73e8')
 *   mode          — 'live' | 'demo' (default: 'live')
 *   userName      — pre-fill user name
 *   userPhone     — pre-fill phone number
 *   userEmail     — pre-fill email
 */

(function () {
  'use strict';

  // ── Config ──────────────────────────────────────────────────────────────────

  const BASE_URL  = (window.HVAC_AI_CONFIG || {}).baseUrl || '';
  const SESSION_ID = (window.HVAC_AI_CONFIG || {}).sessionId || generateUUID();
  const USER_NAME  = (window.HVAC_AI_CONFIG || {}).userName  || '';
  const USER_PHONE = (window.HVAC_AI_CONFIG || {}).userPhone || '';
  const USER_EMAIL = (window.HVAC_AI_CONFIG || {}).userEmail || '';

  // ── SVG Icons ───────────────────────────────────────────────────────────────

  const ICON_CHAT = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M20 2H4c-1.1 0-2 .9-2 2v18l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm0 14H5.17L4 17.17V4h16v12z"/>
    <path d="M7 9h10v2H7zm0-3h7v2H7z"/>
  </svg>`;

  const ICON_SEND = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M2.01 21L23 12 2.01 3 2 10l15 2-15 2z"/>
  </svg>`;

  const ICON_CLOSE = `<svg viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
    <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
  </svg>`;

  // ── Utilities ────────────────────────────────────────────────────────────────

  function generateUUID() {
    return ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
      (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)
    );
  }

  function escapeHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function timeAgo(date) {
    const now  = Date.now();
    const diff = Math.floor((now - date) / 1000);
    if (diff < 60)  return 'just now';
    if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
    return `${Math.floor(diff / 3600)}h ago`;
  }

  function formatTime(date) {
    return new Date(date).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }

  function patchInner(el, html) {
    el.innerHTML = html;
  }

  // ── Widget State ────────────────────────────────────────────────────────────

  const state = {
    messages:    [],       // [{ role, text, time, id }]
    open:        false,
    unread:      0,
    typing:      false,
    company:     'HVAC Pro Services',
    tagline:     'Fast, free quotes',
    accentColor: '#1a73e8',
    welcomeMsg:  "Hi! What can we help you with today?",
    features:    {},
    sending:     false,
  };

  // ── DOM Construction ────────────────────────────────────────────────────────

  let $root, $window, $messages, $input;

  function buildDOM() {
    // ── Launcher ──────────────────────────────────────────────────────────
    const launcher = document.createElement('button');
    launcher.className = 'hvac-launcher';
    launcher.id = 'hvac-launcher';
    launcher.setAttribute('aria-label', 'Open HVAC chat');
    launcher.innerHTML = ICON_CHAT;

    const badge = document.createElement('span');
    badge.className = 'hvac-badge hvac-hidden';
    badge.id = 'hvac-badge';
    badge.textContent = '0';
    launcher.appendChild(badge);

    launcher.addEventListener('click', () => toggleWidget(true));

    // ── Chat Window ─────────────────────────────────────────────────────────
    $window = document.createElement('div');
    $window.className = 'hvac-window hvac-hidden';
    $window.id = 'hvac-window';
    $window.setAttribute('role', 'dialog');
    $window.setAttribute('aria-label', 'HVAC chat');

    $window.innerHTML = `
      <div class="hvac-header">
        <div class="hvac-header-icon">${ICON_CHAT}</div>
        <div class="hvac-header-text">
          <div class="hvac-header-name" id="hvac-co-name">${escapeHtml(state.company)}</div>
          <div class="hvac-header-status">
            <span class="hvac-header-status-dot"></span>
            <span id="hvac-co-status">Typically replies in minutes</span>
          </div>
        </div>
        <button class="hvac-close" id="hvac-close-btn" aria-label="Close chat">${ICON_CLOSE}</button>
      </div>
      <div class="hvac-messages" id="hvac-messages"></div>
      <div class="hvac-input-area">
        <textarea
          class="hvac-input"
          id="hvac-input"
          rows="1"
          placeholder="Type a message..."
          aria-label="Message input"
          maxlength="800"
        ></textarea>
        <button class="hvac-send" id="hvac-send-btn" aria-label="Send message">
          ${ICON_SEND}
        </button>
      </div>
    `;

    $messages = $window.querySelector('#hvac-messages');
    $input    = $window.querySelector('#hvac-input');
    const sendBtn = $window.querySelector('#hvac-send-btn');

    // ── Event Listeners ─────────────────────────────────────────────────────
    $input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    $input.addEventListener('input', () => {
      $input.style.height = 'auto';
      $input.style.height = Math.min($input.scrollHeight, 100) + 'px';
    });

    sendBtn.addEventListener('click', sendMessage);

    $window.querySelector('#hvac-close-btn').addEventListener('click', () => {
      toggleWidget(false);
    });

    // ── Mount ────────────────────────────────────────────────────────────────
    $root = document.createElement('div');
    $root.id = 'hvac-ai-widget-root';
    $root.appendChild($window);
    $root.appendChild(launcher);
    document.body.appendChild($root);
  }

  // ── Render ─────────────────────────────────────────────────────────────────

  function render() {
    // Messages
    $messages.innerHTML = state.messages.map(msg => `
      <div class="hvac-msg ${escapeHtml(msg.role)}">
        <div class="hvac-bubble">${escapeHtml(msg.text)}</div>
        <div class="hvac-time">${msg.time ? formatTime(msg.time) : ''}</div>
      </div>
    `).join('');

    // Suggestions (last bot message only)
    const lastBot = [...state.messages].reverse().find(m => m.role === 'bot');
    if (lastBot && lastBot.suggestions && lastBot.suggestions.length > 0) {
      const suggHtml = lastBot.suggestions.map(s =>
        `<button class="hvac-suggestion">${escapeHtml(s)}</button>`
      ).join('');
      const suggEl = document.createElement('div');
      suggEl.className = 'hvac-suggestions';
      suggEl.innerHTML = suggHtml;
      suggEl.querySelectorAll('.hvac-suggestion').forEach(btn => {
        btn.addEventListener('click', () => {
          $input.value = btn.textContent.trim();
          sendMessage();
        });
      });
      $messages.appendChild(suggEl);
    }

    $messages.scrollTop = $messages.scrollHeight;
  }

  function addMessage(role, text, suggestions = []) {
    state.messages.push({
      id:          generateUUID(),
      role,
      text,
      time:        Date.now(),
      suggestions,
    });
    if (!state.open && role === 'bot') {
      state.unread++;
      updateBadge();
    }
    render();
  }

  function setTyping(on) {
    state.typing = on;
    let $existing = $messages.querySelector('.hvac-typing');
    if (on && !$existing) {
      const el = document.createElement('div');
      el.className = 'hvac-typing';
      el.id = 'hvac-typing';
      el.innerHTML = '<div class="hvac-typing-dot"></div><div class="hvac-typing-dot"></div><div class="hvac-typing-dot"></div>';
      $messages.appendChild(el);
      $messages.scrollTop = $messages.scrollHeight;
    } else if (!on && $existing) {
      $existing.remove();
    }
  }

  function updateBadge() {
    const badge = document.getElementById('hvac-badge');
    if (!badge) return;
    if (state.unread > 0) {
      badge.textContent = state.unread > 9 ? '9+' : state.unread;
      badge.classList.remove('hvac-hidden');
    } else {
      badge.classList.add('hvac-hidden');
    }
  }

  // ── Send Message ────────────────────────────────────────────────────────────

  async function sendMessage() {
    const text = $input.value.trim();
    if (!text || state.sending) return;

    state.sending = true;
    $input.value = '';
    $input.style.height = 'auto';

    addMessage('user', text);
    setTyping(true);

    try {
      const res = await fetch(`${BASE_URL}/web/chat`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: SESSION_ID,
          message:   text,
          name:     USER_NAME,
          phone:    USER_PHONE,
          email:    USER_EMAIL,
        }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const data = await res.json();

      setTyping(false);

      if (data.error) {
        addMessage('bot', 'Something went wrong. Please try again or call us directly.');
      } else {
        addMessage('bot', data.text || "Thanks — we'll be in touch shortly.", data.suggestions || []);
      }
    } catch (err) {
      setTyping(false);
      addMessage('bot', "It looks like we're having connection issues. Please call us at your convenience.");
    } finally {
      state.sending = false;
    }
  }

  // ── Toggle Widget ──────────────────────────────────────────────────────────

  function toggleWidget(open) {
    state.open = open;
    const launcher = document.getElementById('hvac-launcher');
    if (open) {
      state.unread = 0;
      updateBadge();
      $window.classList.remove('hvac-hidden');
      launcher.classList.add('open');
      launcher.innerHTML = ICON_CLOSE;
      launcher.setAttribute('aria-label', 'Close HVAC chat');
      $input.focus();
    } else {
      $window.classList.add('hvac-hidden');
      launcher.classList.remove('open');
      launcher.innerHTML = ICON_CHAT;
      launcher.setAttribute('aria-label', 'Open HVAC chat');
    }
  }

  // ── Bootstrap ───────────────────────────────────────────────────────────────

  async function init() {
    // Fetch widget config from server (with fallback defaults)
    try {
      const res = await fetch(`${BASE_URL}/web/chat`);
      if (res.ok) {
        const cfg = await res.json();
        if (cfg.company)       state.company     = cfg.company;
        if (cfg.tagline)       state.tagline     = cfg.tagline;
        if (cfg.accentColor)   state.accentColor = cfg.accentColor;
        if (cfg.welcomeMessage) state.welcomeMsg = cfg.welcomeMessage;
        if (cfg.phone) {
          // Store for potential SMS follow-up
          window.HVAC_AI_CONFIG = window.HVAC_AI_CONFIG || {};
          window.HVAC_AI_CONFIG.companyPhone = cfg.phone;
        }
        if (cfg.features) state.features = cfg.features;

        // Apply accent color
        document.documentElement.style.setProperty('--w-primary', state.accentColor);
        document.documentElement.style.setProperty('--w-header-bg', state.accentColor);
      }
    } catch {
      // Non-fatal — use defaults
    }

    buildDOM();
    addMessage('bot', state.welcomeMsg);
  }

  // ── Expose API ─────────────────────────────────────────────────────────────

  window.HVAC_AI = {
    toggle:    () => toggleWidget(!state.open),
    open:      () => toggleWidget(true),
    close:     () => toggleWidget(false),
    send:      (text) => { $input.value = text; sendMessage(); },
    configure: (opts) => Object.assign(window.HVAC_AI_CONFIG || {}, opts),
    state,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
