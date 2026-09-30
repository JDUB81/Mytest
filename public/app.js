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
  // Deal page: picking from the add-on price list fills in the fields (still editable).
  var addonForm = document.getElementById('addon-form');
  if (addonForm) {
    addonForm.querySelector('.addon-pick').addEventListener('change', function (e) {
      var opt = e.target.selectedOptions[0];
      if (!opt || !opt.value) return;
      addonForm.elements.description.value = opt.dataset.name;
      // A $0 price means "not set yet" on the jobs list, so leave the box empty to type one.
      addonForm.elements.price.value = Number(opt.dataset.price) ? opt.dataset.price : '';
      if (addonForm.elements.cost && opt.dataset.cost !== undefined) addonForm.elements.cost.value = Number(opt.dataset.cost) ? opt.dataset.cost : '';
      addonForm.elements.taxable.checked = opt.dataset.taxable === '1';
      addonForm.elements.price.focus();
    });
  }

  // Write-a-check page.
  var checkForm = document.getElementById('check-form');
  if (checkForm) {
    var moneyFmt = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
    // Choosing a deal reloads the page to show that deal's jobs and allotments.
    document.getElementById('deal-select').addEventListener('change', function (e) {
      var params = new URLSearchParams();
      if (e.target.value) params.set('deal_id', e.target.value);
      var vendor = checkForm.elements.vendor_id.value;
      if (vendor) params.set('vendor_id', vendor);
      window.location = '/books/checks/new' + (params.toString() ? '?' + params : '');
    });

    var showPayee = function () {
      var type = (checkForm.querySelector('input[name="payee_type"]:checked') || {}).value || 'vendor';
      checkForm.querySelectorAll('[data-payee]').forEach(function (el) { el.hidden = el.dataset.payee !== type; });
    };
    checkForm.querySelectorAll('input[name="payee_type"]').forEach(function (r) { r.addEventListener('change', showPayee); });
    showPayee();

    var amount = document.getElementById('check-amount');
    var warning = document.getElementById('budget-warning');
    var rate = Number(checkForm.dataset.rate) || 0;
    var checkBudget = function () {
      var line = checkForm.querySelector('input[name="deal_item_id"]:checked');
      var value = Number(String(amount.value).replace(/[$,\s]/g, ''));
      if (!line || !value) { warning.hidden = true; return; }
      var over = Math.round((value - Math.max(0, Number(line.dataset.remaining))) * 100) / 100;
      if (over <= 0) { warning.hidden = true; return; }
      warning.textContent = 'This is ' + moneyFmt.format(over) + ' over what is allotted for ' + line.dataset.label + '.' +
        (rate ? ' The salesperson’s commission will be reduced by ' + moneyFmt.format(over * rate / 100) + ' (' + rate + '%).' : '');
      warning.hidden = false;
    };
    checkForm.querySelectorAll('input[name="deal_item_id"]').forEach(function (r) {
      r.addEventListener('change', function () {
        // Pre-select the job's usual vendor if none is chosen yet.
        var vendorSelect = checkForm.elements.vendor_id;
        if (r.dataset.vendor && vendorSelect && !vendorSelect.value) vendorSelect.value = r.dataset.vendor;
        // Suggest paying what's left on that job.
        var left = Number(r.dataset.remaining);
        if (left > 0 && !amount.value) amount.value = left.toFixed(2);
        checkBudget();
      });
    });
    amount.addEventListener('input', checkBudget);
    var preselected = checkForm.querySelector('input[name="deal_item_id"]:checked');
    if (preselected && !amount.value && Number(preselected.dataset.remaining) > 0) amount.value = Number(preselected.dataset.remaining).toFixed(2);
    checkBudget();
  }
  // Credit application: hide the co-applicant column when there isn't one.
  var creditForm = document.getElementById('credit-form');
  if (creditForm) {
    var coBox = document.getElementById('has-co');
    var syncCo = function () { creditForm.classList.toggle('no-co', !coBox.checked); };
    coBox.addEventListener('change', syncCo);
    syncCo();
  }
})();
