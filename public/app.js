// Small progressive enhancements; every page works without this script.
(function () {
  function isoDate(offsetDays) {
    var d = new Date();
    d.setDate(d.getDate() + offsetDays);
    var pad = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  // Customer page: "Tomorrow / 3 days / 1 week" follow-up shortcuts.
  document.querySelectorAll('[data-days]').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var input = btn.closest('form').querySelector('input[name="follow_up_date"]');
      if (input) input.value = isoDate(Number(btn.dataset.days));
    });
  });

  // Deal page: ask why a payment is being voided.
  document.querySelectorAll('.void-form').forEach(function (form) {
    form.addEventListener('submit', function (e) {
      var reason = window.prompt('Why is this payment being voided?');
      if (!reason) { e.preventDefault(); return; }
      form.querySelector('input[name="reason"]').value = reason;
    });
  });

  // Deal edit page: live estimate of the total as prices change (mirrors src/deals.js).
  var form = document.getElementById('deal-form');
  if (form) {
    var money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    var val = function (name) {
      var n = Number(String(form.elements[name].value).replace(/[$,\s]/g, ''));
      return isFinite(n) ? n : 0;
    };
    var round2 = function (n) { return Math.round(n * 100) / 100; };
    var items = Number(form.querySelector('[data-items]').dataset.items) || 0;
    var taxableItems = Number(form.querySelector('[data-taxable-items]').dataset.taxableItems) || 0;
    var balanceEl = form.querySelector('[data-out="balance"]');
    var paid = Number(balanceEl.dataset.paid) || 0;
    var update = function () {
      var homeNet = round2(val('sale_price') - val('discount'));
      var taxableBase = Math.max(0, round2(homeNet + taxableItems - val('trade_allowance')));
      var tax = round2(taxableBase * val('tax_rate') / 100);
      var total = round2(homeNet + items + val('doc_fee') + tax - (val('trade_allowance') - val('trade_payoff')));
      form.querySelector('[data-out="total"]').textContent = money.format(total);
      form.querySelector('[data-out="tax"]').textContent = money.format(tax);
      balanceEl.textContent = money.format(round2(total - paid));
    };
    form.querySelectorAll('[data-calc]').forEach(function (el) { el.addEventListener('input', update); });
  }
})();
