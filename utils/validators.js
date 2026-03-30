/* ============================================================
   VALIDATORS — Form validation helpers
   ============================================================ */

window.Validators = {
    required(value, fieldName) {
        if (!value || (typeof value === 'string' && value.trim() === '')) {
            return `${fieldName} zorunludur`;
        }
        return null;
    },

    positiveNumber(value, fieldName) {
        const num = parseFloat(value);
        if (isNaN(num) || num < 0) {
            return `${fieldName} geçerli bir pozitif sayı olmalıdır`;
        }
        return null;
    },

    date(value, fieldName) {
        if (!value || isNaN(new Date(value).getTime())) {
            return `${fieldName} geçerli bir tarih olmalıdır`;
        }
        return null;
    },

    /**
     * Validate a form object
     * @param {Object} data - form data
     * @param {Object} rules - { fieldName: [validator, ...] }
     * @returns {string[]} array of error messages
     */
    validate(data, rules) {
        const errors = [];
        for (const [field, validators] of Object.entries(rules)) {
            for (const validator of validators) {
                const error = validator(data[field], field);
                if (error) {
                    errors.push(error);
                    break;
                }
            }
        }
        return errors;
    }
};
