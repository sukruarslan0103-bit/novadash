/* ============================================================
   GLOBAL ERROR HANDLER
   Merkezi hata yakalama ve kullanıcı mesaj sistemi
   ============================================================ */

window.ErrorHandler = (function () {

    'use strict';

    function log(error, context = 'Unknown') {

        console.error('❌ APPLICATION ERROR');
        console.error('Context:', context);
        console.error(error);

    }

    function userMessage(error) {

        if (!error) return 'Beklenmeyen bir hata oluştu.';

        if (typeof error === 'string') return error;

        if (error.message) return error.message;

        return 'Beklenmeyen bir sistem hatası oluştu.';
    }

    function show(error, context = 'Unknown') {

        log(error, context);

        const message = userMessage(error);

        if (window.UI && typeof window.UI.showError === 'function') {

            window.UI.showError(message);

        } else if (window.Toast && typeof window.Toast.error === 'function') {

            window.Toast.error(message);

        } else {

            console.error('[ErrorHandler fallback]', message);

        }

    }

    function wrapAsync(fn, context = 'AsyncOperation') {

        return async function (...args) {

            try {

                return await fn(...args);

            } catch (error) {

                show(error, context);
                return null;

            }

        };

    }

    function guard(promise, context = 'Promise') {

        return promise.catch(error => {

            show(error, context);
            return null;

        });

    }

    /* ============================================================
       GLOBAL LISTENERS
    ============================================================ */

    window.addEventListener('error', function (event) {

        show(event.error || event.message, 'GlobalError');

    });

    window.addEventListener('unhandledrejection', function (event) {

        show(event.reason, 'UnhandledPromise');

    });

    return {
        show,
        log,
        guard,
        wrapAsync
    };

})();