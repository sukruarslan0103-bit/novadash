/* ============================================================
   TOAST NOTIFICATION SYSTEM
   Non-blocking, stackable, auto-dismiss toast messages
   ============================================================ */

window.Toast = (function () {
    'use strict';

    var containerId = 'toastContainer';
    var defaultDuration = 3500;

    function getContainer() {
        var el = document.getElementById(containerId);
        if (el) return el;

        el = document.createElement('div');
        el.id = containerId;
        document.body.appendChild(el);
        return el;
    }

    function getIcon(type) {
        if (type === 'success') {
            return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"/></svg>';
        }
        if (type === 'error') {
            return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
        }
        return '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>';
    }

    function show(message, type, duration) {
        if (!message) return;

        type = type || 'info';
        duration = duration || defaultDuration;

        var container = getContainer();

        var toast = document.createElement('div');
        toast.className = 'toast-item toast-' + type;

        toast.innerHTML =
            '<div class="toast-icon">' + getIcon(type) + '</div>' +
            '<div class="toast-message">' + escapeHtml(message) + '</div>' +
            '<button class="toast-close" type="button">&times;</button>';

        container.appendChild(toast);

        // trigger enter animation
        requestAnimationFrame(function () {
            toast.classList.add('toast-visible');
        });

        var closeBtn = toast.querySelector('.toast-close');
        if (closeBtn) {
            closeBtn.addEventListener('click', function () {
                dismiss(toast);
            });
        }

        var timer = setTimeout(function () {
            dismiss(toast);
        }, duration);

        toast._timer = timer;
    }

    function dismiss(toast) {
        if (!toast || toast._dismissed) return;
        toast._dismissed = true;

        clearTimeout(toast._timer);
        toast.classList.remove('toast-visible');
        toast.classList.add('toast-exit');

        setTimeout(function () {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

    function success(message, duration) {
        show(message, 'success', duration);
    }

    function error(message, duration) {
        show(message, 'error', duration);
    }

    function info(message, duration) {
        show(message, 'info', duration);
    }

    return { show: show, success: success, error: error, info: info };

})();
