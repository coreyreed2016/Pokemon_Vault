(() => {
  'use strict';

  const API = 'https://api.pokemontcg.io/v2/cards';
  const CACHE_KEY = 'lucario-ledger.catalog.v1';
  const DATA_KEY = 'lucario-ledger.data.v1';
  const MONTHLY_BUDGET = 50;
  const STALE_AFTER_DAYS = 7;
  const state = {
    cards: [],
    data: loadData(),
    view: 'all',
    query: '',
    sort: 'newest',
    filters: { rarity: '', condition: '', language: '', type: '' },
    loading: false,
    dialogCard: null,
    pricesCard: null,
    editingGroupIndex: null,
    toastTimer: null
  };
  const $ = (selector) => document.querySelector(selector);

  function loadData() {
    try {
      const parsed = JSON.parse(localStorage.getItem(DATA_KEY) || '{}');
      return {
        owned: Array.isArray(parsed.owned) ? parsed.owned : [],
        wishlist: Array.isArray(parsed.wishlist) ? parsed.wishlist : [],
        expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
        favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
        tcgplayerLinks: parsed.tcgplayerLinks && typeof parsed.tcgplayerLinks === 'object' &&
          !Array.isArray(parsed.tcgplayerLinks) ? parsed.tcgplayerLinks : {}
      };
    } catch (error) {
      console.error('Could not read saved collection data:', error);
      return { owned: [], wishlist: [], expenses: [], favorites: [] };
    }
  }

  function saveData() {
    try {
      localStorage.setItem(DATA_KEY, JSON.stringify(state.data));
    } catch (error) {
      console.error('Could not save collection data:', error);
      showToast('Could not save: device storage may be full or unavailable.');
      return false;
    }
    return true;
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
    })[character]);
  }

  function formatMoney(value) {
    if (!Number.isFinite(value)) return 'Unavailable';
    return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value);
  }

  function cardPrice(card, variant) {
    const prices = card?.tcgplayer?.prices;
    if (!prices) return null;
    const match = prices[variant];
    const amount = match?.market;
    return typeof amount === 'number' && Number.isFinite(amount) && amount >= 0 ? amount : null;
  }

  function pricesFor(card) {
    const prices = card?.tcgplayer?.prices || {};
    return Object.keys(prices).filter((key) => typeof prices[key]?.market === 'number');
  }

  function displayVariant(key) {
    return key.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (char) => char.toUpperCase());
  }

  function keyForVariant(value) {
    return value.trim().toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, next) => next.toUpperCase());
  }

  function validTcgplayerProductUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'https:' &&
        (url.hostname === 'tcgplayer.com' || url.hostname.endsWith('.tcgplayer.com')) &&
        /^\/product\/\d+(?:\/|$)/i.test(url.pathname);
    } catch {
      return false;
    }
  }

  function isStale(card) {
    const updatedAt = card?.tcgplayer?.updatedAt;
    if (!updatedAt) return true;
    const age = Date.now() - new Date(updatedAt).getTime();
    return !Number.isFinite(age) || age > STALE_AFTER_DAYS * 86400000;
  }

  function cardOwned(cardId) {
    return state.data.owned.filter((item) => item.cardId === cardId).reduce((sum, item) => sum + item.copies.length, 0);
  }

  function cardWished(cardId) {
    return state.data.wishlist.some((item) => item.cardId === cardId);
  }

  function totalOwnedPrints() {
    return new Set(state.data.owned.map((item) => item.cardId)).size;
  }

  function monthlyExpenses() {
    const month = localMonth(new Date());
    return state.data.expenses.filter((expense) => expense.month === month ||
      (!expense.month && expense.date && localMonth(new Date(expense.date)) === month))
      .reduce((sum, expense) => sum + Number(expense.amount || 0), 0);
  }

  function localMonth(date) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
  }

  function currentCard(id) {
    return state.cards.find((card) => card.id === id) || null;
  }

  function cardLanguage(card) {
    return card.language || card.set?.language || 'English';
  }

  function cardValue(cardId, variant) {
    const card = currentCard(cardId);
    const key = keyForVariant(variant);
    return card ? cardPrice(card, key) : null;
  }

  function refreshOverview() {
    const uniqueOwned = totalOwnedPrints();
    const total = state.cards.length;
    const ownedValue = state.data.owned.reduce((sum, item) => {
      const value = cardValue(item.cardId, item.variant);
      return sum + (value === null ? 0 : value * item.copies.length);
    }, 0);
    const unpricedOwnedCopies = state.data.owned.reduce((sum, item) =>
      sum + (cardValue(item.cardId, item.variant) === null ? item.copies.length : 0), 0);
    const wishlistValue = state.data.wishlist.reduce((sum, item) => {
      const value = cardValue(item.cardId, item.variant);
      return sum + (value ?? 0);
    }, 0);
    const unpricedWishlistItems = state.data.wishlist.filter((item) => cardValue(item.cardId, item.variant) === null).length;
    const spent = monthlyExpenses();
    const ratio = total ? Math.min(100, uniqueOwned / total * 100) : 0;
    $('#owned-count').textContent = String(uniqueOwned);
    $('#total-count').textContent = `${total} catalog prints`;
    $('#total-count-stat').textContent = `of ${total || '—'}`;
    $('#progress-bar').style.width = `${ratio}%`;
    $('#progress-label').textContent = total ? 'Unique prints collected' : 'Catalog loading';
    $('#progress-percent').textContent = total ? `${Math.round(ratio)}%` : '—';
    $('#collection-value').textContent = formatMoney(ownedValue);
    $('#collection-value-note').textContent = unpricedOwnedCopies
      ? `Estimate · ${unpricedOwnedCopies} unpriced ${unpricedOwnedCopies === 1 ? 'copy' : 'copies'}`
      : 'Owned cards · estimated';
    $('#wishlist-value').textContent = formatMoney(wishlistValue);
    $('#wishlist-count').textContent = `${state.data.wishlist.length} ${state.data.wishlist.length === 1 ? 'card' : 'cards'}${unpricedWishlistItems ? ` · ${unpricedWishlistItems} unpriced` : ''}`;
    $('#budget-remaining').textContent = formatMoney(Math.max(0, MONTHLY_BUDGET - spent));
    $('#budget-spent').textContent = `${formatMoney(spent)} spent of $50`;
    $('#budget-bar').style.width = `${Math.min(100, spent / MONTHLY_BUDGET * 100)}%`;
    $('#all-tab-count').textContent = total ? String(total) : '—';
    $('#owned-tab-count').textContent = String(uniqueOwned);
    $('#missing-tab-count').textContent = total ? String(Math.max(0, total - uniqueOwned)) : '—';
    $('#wishlist-tab-count').textContent = String(state.data.wishlist.length);
    $('#nav-owned-count').textContent = String(uniqueOwned);
    $('#nav-wishlist-count').textContent = String(state.data.wishlist.length);
  }

  function statusForPrice(card, variant) {
    const amount = cardPrice(card, variant);
    if (amount === null) return '<span class="tile-price unavailable">Price unavailable</span>';
    return `<span class="tile-price">${formatMoney(amount)}</span>${isStale(card) ? '<span class="price-stale" title="Price data is more than 7 days old">STALE</span>' : ''}`;
  }

  function ownedDetails(card) {
    return state.data.owned.filter((item) => item.cardId === card.id).map((item) => {
      const paid = item.copies.reduce((sum, copy) => sum + Number(copy.paid || 0), 0);
      const key = keyForVariant(item.variant);
      const market = cardPrice(card, key);
      const treatmentVerified = Object.hasOwn(card.tcgplayer?.prices || {}, key);
      return `<div class="owned-entry"><span>${escapeHtml(item.variant)} · ${escapeHtml(item.condition)}${treatmentVerified ? '' : ' · unverified'}</span><span>${item.copies.length}× · paid ${formatMoney(paid)} · market ${market === null ? 'unavailable' : formatMoney(market)}${market !== null && isStale(card) ? ' · stale' : ''}</span></div>`;
    }).join('');
  }

  function wishlistDetails(card) {
    return state.data.wishlist.filter((item) => item.cardId === card.id).map((item) => {
      const key = keyForVariant(item.variant);
      const amount = cardPrice(card, key);
      const treatmentVerified = Object.hasOwn(card.tcgplayer?.prices || {}, key);
      return `<div class="wish-entry">${escapeHtml(item.variant)} · ${amount === null ? 'market unavailable' : formatMoney(amount)}${amount !== null && isStale(card) ? ' · stale' : ''}${treatmentVerified ? '' : ' · unverified treatment'}</div>`;
    }).join('');
  }

  function escapeAttribute(value) {
    return escapeHtml(value);
  }

  function isFavorite(cardId) {
    return state.data.favorites.includes(cardId);
  }

  function rarityClass(card) {
    const rarity = (card.rarity || '').toLowerCase();
    if (/rare|ultra|secret|hyper|amazing|shiny/.test(rarity) && /ultra|secret|hyper|shiny/.test(rarity)) return 'rarity-ultra';
    if (/rare|amazing/.test(rarity)) return 'rarity-rare';
    const price = Math.max(-1, ...Object.keys(card.tcgplayer?.prices || {}).map((key) => cardPrice(card, key) ?? -1));
    return price >= 50 ? 'rarity-valuable' : '';
  }

  function isPromotional(card) {
    return /promo|promotional|league|prerelease|staff/i.test(`${card.set?.name || ''} ${card.name || ''} ${card.subtypes?.join(' ') || ''}`);
  }

  function isStamped(card) {
    return /stamp|stamped|staff|league|prerelease/i.test(`${card.name || ''} ${card.set?.name || ''} ${card.flavorText || ''}`);
  }

  function spotlightCard(card, subtitle, action = 'details') {
    const art = card.images?.small || card.images?.large;
    const price = cardPrice(card, pricesFor(card)[0] || 'normal');
    return `<button class="spotlight-card" type="button" data-action="${action}" data-card-id="${escapeAttribute(card.id)}">
      <span class="spotlight-art">${art ? `<img class="card-art" src="${escapeAttribute(art)}" alt="" loading="lazy">` : '<span class="no-art">L</span>'}</span>
      <span class="spotlight-info"><strong>${escapeHtml(card.name)}</strong><span>${escapeHtml(subtitle || card.set?.name || 'Lucario card')}</span><span class="spotlight-price">${price === null ? 'Market unavailable' : formatMoney(price)}</span></span>
    </button>`;
  }

  function renderDashboard() {
    const recent = state.data.owned.flatMap((item) => item.copies.map((copy) => ({
      card: currentCard(item.cardId),
      date: copy.addedAt || '',
      condition: item.condition
    }))).filter((entry) => entry.card)
      .sort((a, b) => b.date.localeCompare(a.date))
      .filter((entry, index, entries) => entries.findIndex((other) => other.card.id === entry.card.id) === index)
      .slice(0, 3);
    $('#recent-grid').innerHTML = recent.length
      ? recent.map((entry) => spotlightCard(entry.card, `${entry.card.set?.name || 'Lucario'} · ${entry.condition}`)).join('')
      : '<div class="empty-inline">Add your first card to see it here.</div>';

    const favoriteCards = state.data.favorites.map(currentCard).filter(Boolean).slice(0, 4);
    $('#favorites-count').textContent = `${state.data.favorites.length} SAVED`;
    $('#favorites-grid').innerHTML = favoriteCards.length
      ? favoriteCards.map((card) => spotlightCard(card, card.set?.name, 'details')).join('')
      : '<div class="empty-inline">Tap the star on a card to feature it here.</div>';

    const wishlist = state.data.wishlist.slice(0, 3);
    $('#wishlist-highlights').innerHTML = wishlist.length
      ? wishlist.map((item) => {
        const card = currentCard(item.cardId);
        if (!card) return '';
        const price = cardPrice(card, keyForVariant(item.variant));
        const art = card.images?.small || card.images?.large;
        return `<button class="wishlist-highlight" type="button" data-action="details" data-card-id="${escapeAttribute(card.id)}">
          <span class="spotlight-art">${art ? `<img class="card-art" src="${escapeAttribute(art)}" alt="" loading="lazy">` : '<span class="no-art">L</span>'}</span>
          <span class="spotlight-info"><strong>${escapeHtml(card.name)}</strong><span>${escapeHtml(card.set?.name || item.variant)}</span><span class="spotlight-price">${price === null ? 'Price unavailable' : formatMoney(price)}</span></span><span class="wishlist-heart">♡</span>
        </button>`;
      }).join('')
      : '<div class="empty-inline">Your wishlist is ready for its next treasure.</div>';

    const sets = new Map();
    for (const card of state.cards) {
      const setName = card.set?.name || 'Unlisted set';
      if (!sets.has(setName)) sets.set(setName, { total: 0, owned: 0 });
      const row = sets.get(setName);
      row.total += 1;
      if (cardOwned(card.id)) row.owned += 1;
    }
    const setRows = [...sets].sort((a, b) => b[1].total - a[1].total || a[0].localeCompare(b[0])).slice(0, 8);
    $('#set-progress-list').innerHTML = setRows.length
      ? setRows.map(([name, row]) => `<div class="set-progress-row"><div class="set-progress-label"><span>${escapeHtml(name)}</span><span>${row.owned}/${row.total}</span></div><div class="set-track"><span style="width:${row.total ? row.owned / row.total * 100 : 0}%"></span></div></div>`).join('')
      : '<div class="empty-inline">Set completion appears when the live catalog is available.</div>';
  }

  function populateFilters() {
    const raritySelect = $('#rarity-filter');
    const languageSelect = $('#language-filter');
    const selectedRarity = raritySelect.value;
    const selectedLanguage = languageSelect.value;
    const rarities = [...new Set(state.cards.map((card) => card.rarity).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const languages = [...new Set(state.cards.map(cardLanguage))].sort((a, b) => a.localeCompare(b));
    raritySelect.innerHTML = '<option value="">All rarities</option>' + rarities.map((rarity) => `<option value="${escapeAttribute(rarity)}">${escapeHtml(rarity)}</option>`).join('');
    languageSelect.innerHTML = '<option value="">All languages</option>' + languages.map((language) => `<option value="${escapeAttribute(language)}">${escapeHtml(language)}</option>`).join('');
    raritySelect.value = rarities.includes(selectedRarity) ? selectedRarity : '';
    languageSelect.value = languages.includes(selectedLanguage) ? selectedLanguage : '';
  }

  function cardTile(card) {
    const owned = cardOwned(card.id);
    const wished = cardWished(card.id);
    const missing = state.view === 'missing' && !owned;
    const rarity = card.rarity || 'Rarity not listed';
    const number = card.number ? `#${card.number}` : 'No. unavailable';
    const setName = card.set?.name || 'Set unavailable';
    const variantKeys = pricesFor(card);
    const mainVariant = variantKeys[0] || 'normal';
    const art = card.images?.large || card.images?.small;
    const verified = card.name && card.set?.name && card.number;
    const market = cardPrice(card, mainVariant);
    const favorite = isFavorite(card.id);
    const tags = [isPromotional(card) ? 'PROMO' : '', isStamped(card) ? 'STAMPED' : ''].filter(Boolean);
    return `<article class="card-tile ${rarityClass(card)}">
      <button class="card-open" type="button" data-action="details" data-card-id="${escapeHtml(card.id)}" aria-label="View ${escapeHtml(card.name)}, ${escapeHtml(setName)}, number ${escapeHtml(card.number || 'unknown')} details">
      <span class="card-art-wrap">
        ${owned ? `<span class="tile-mark">${owned} OWNED</span>` : missing ? '<span class="tile-mark missing-mark">MISSING</span>' : wished ? '<span class="tile-mark wish-mark">WISHLIST</span>' : ''}
        ${art ? `<img class="card-art" src="${escapeHtml(art)}" alt="${escapeHtml(card.name)} — ${escapeHtml(setName)}" loading="lazy" decoding="async">` : '<span class="no-art" role="img" aria-label="Card artwork unavailable">L</span>'}
      </span>
      <span class="tile-body">
        <span class="tile-set" title="${escapeHtml(setName)}">${escapeHtml(setName)}</span>
        <span class="tile-title" title="${escapeHtml(card.name)}">${escapeHtml(card.name)}</span>
        <span class="tile-subline"><span>${escapeHtml(number)}</span><span>${escapeHtml(rarity)}</span></span>
        <span class="tile-price-row">${statusForPrice(card, mainVariant)}</span>
        <span class="tile-compare-hint">Compare sources ↗</span>
        ${tags.length ? `<span class="card-tags">${tags.map((tag) => `<span>${tag}</span>`).join('')}</span>` : ''}
      </span>
      </button>
      <div class="tile-body tile-controls">
        <div class="tile-actions">
          ${owned && state.view === 'owned'
            ? `<button class="tile-action secondary missing-action" type="button" data-action="missing" data-card-id="${escapeHtml(card.id)}">Mark missing</button>`
            : `<button class="tile-action" type="button" data-action="owned" data-card-id="${escapeHtml(card.id)}">${owned ? '+ Add copy' : '+ Add'}</button>`}
          <button class="tile-action secondary ${wished ? 'wish-active' : ''}" type="button" data-action="wishlist" data-card-id="${escapeHtml(card.id)}" aria-label="${wished ? 'Remove from wishlist' : 'Add to wishlist'}">${wished ? '♥' : '♡'}</button>
          <button class="tile-action secondary favorite-action ${favorite ? 'favorite-active' : ''}" type="button" data-action="favorite" data-card-id="${escapeHtml(card.id)}" aria-label="${favorite ? 'Remove featured favorite' : 'Feature as favorite'}">${favorite ? '★' : '☆'}</button>
        </div>
        <div class="tile-details">${verified ? '<span class="verified-mark">● Source verified</span>' : '<span class="unverified-mark">● Incomplete source data</span>'}${market === null ? ' · No market quote' : ` · ${escapeHtml(displayVariant(mainVariant))}`}</div>
        ${state.view === 'owned' ? `<div class="owned-details">${ownedDetails(card)}</div>` : ''}
        ${state.view === 'wishlist' ? `<div class="wish-details">${wishlistDetails(card)}</div>` : ''}
      </div>
    </article>`;
  }

  function visibleCards() {
    const query = state.query.trim().toLowerCase();
    let cards = state.cards.filter((card) => {
      if (state.view === 'owned' && cardOwned(card.id) === 0) return false;
      if (state.view === 'missing' && cardOwned(card.id) > 0) return false;
      if (state.view === 'wishlist' && !cardWished(card.id)) return false;
      if (state.filters.rarity && card.rarity !== state.filters.rarity) return false;
      if (state.filters.language && cardLanguage(card) !== state.filters.language) return false;
      if (state.filters.type === 'promo' && !isPromotional(card)) return false;
      if (state.filters.type === 'stamp' && !isStamped(card)) return false;
      if (state.filters.condition && !state.data.owned.some((item) => item.cardId === card.id && item.condition === state.filters.condition)) return false;
      if (query && ![card.name, card.number, card.rarity, card.set?.name, card.id, card.supertype, ...(card.subtypes || [])]
        .some((value) => String(value || '').toLowerCase().includes(query))) return false;
      return true;
    });
    cards = [...cards];
    cards.sort((a, b) => {
      if (state.sort === 'name') return (a.name || '').localeCompare(b.name || '');
      if (state.sort === 'set') return (a.set?.name || '').localeCompare(b.set?.name || '');
      if (state.sort === 'price-high' || state.sort === 'price-low') {
        const aPrice = Math.max(-1, ...Object.keys(a.tcgplayer?.prices || {}).map((key) => cardPrice(a, key) ?? -1));
        const bPrice = Math.max(-1, ...Object.keys(b.tcgplayer?.prices || {}).map((key) => cardPrice(b, key) ?? -1));
        return state.sort === 'price-high' ? bPrice - aPrice : aPrice - bPrice;
      }
      const latestAdded = (card) => Math.max(-1, ...state.data.owned.filter((item) => item.cardId === card.id)
        .flatMap((item) => item.copies.map((copy) => new Date(copy.addedAt || 0).getTime())));
      if (state.sort === 'date-added') return latestAdded(b) - latestAdded(a);
      return (b.set?.releaseDate || '').localeCompare(a.set?.releaseDate || '');
    });
    return cards;
  }

  function renderCatalog() {
    populateFilters();
    const cards = visibleCards();
    $('#catalog-grid').innerHTML = state.loading && !state.cards.length
      ? Array.from({ length: 6 }, () => '<div class="skeleton-card" aria-hidden="true"><div class="skeleton-art"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>').join('')
      : cards.map(cardTile).join('');
    $('#catalog-grid').hidden = !cards.length && !(state.loading && !state.cards.length);
    $('#empty-state').hidden = cards.length !== 0 || (state.loading && !state.cards.length);
    $('#result-count').textContent = state.cards.length
      ? `${cards.length} ${cards.length === 1 ? 'print' : 'prints'}${state.view === 'all' ? ' in the Lucario catalog' : ` · ${state.view}`}`
      : 'No catalog records available';
    if (!cards.length) {
      if (!state.cards.length) {
        $('#empty-title').textContent = state.loading ? 'Loading the card catalog' : 'Catalog unavailable';
        $('#empty-copy').textContent = state.loading
          ? 'Connecting to the live Pokémon TCG catalog…'
          : 'Check your connection and refresh. Your saved collection remains on this device.';
        $('#empty-action').textContent = 'Refresh catalog';
      } else {
        $('#empty-title').textContent = state.view === 'owned' ? 'Your collection is waiting' : state.view === 'missing' ? 'Every print is accounted for' : state.view === 'wishlist' ? 'Your wishlist is empty' : 'No matching cards';
        $('#empty-copy').textContent = state.view === 'all'
          ? 'Try a different search, or refresh the live card catalog.'
          : state.view === 'missing' ? 'You have marked every catalog print as owned.'
            : 'Browse all Lucario prints to find a card to add here.';
        $('#empty-action').textContent = state.view === 'all' ? 'Refresh catalog' : 'Show all prints';
      }
    }
    refreshOverview();
    renderDashboard();
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll('.tab').forEach((tab) => {
      const active = tab.dataset.view === view;
      tab.classList.toggle('active', active);
      tab.setAttribute('aria-selected', String(active));
    });
    renderCatalog();
  }

  function navigateTo(destination) {
    if (destination === 'wishlist') setView('wishlist');
    else if (state.view === 'wishlist') setView('all');
    const target = destination === 'home' ? $('#home') : $('#collection');
    $('#page-label').textContent = destination === 'home' ? 'OVERVIEW' : destination === 'wishlist' ? 'WISHLIST' : 'COLLECTION';
    document.querySelectorAll('[data-nav]').forEach((button) => {
      const active = button.dataset.nav === destination;
      button.classList.toggle('active', active);
    });
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  function showToast(message) {
    const toast = $('#toast');
    toast.textContent = message;
    toast.classList.add('visible');
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => toast.classList.remove('visible'), 2600);
  }

  function cacheCards(cards) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ savedAt: new Date().toISOString(), cards }));
    } catch (error) {
      console.warn('Could not cache card catalog:', error);
    }
  }

  function restoreCatalogCache() {
    try {
      const cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (cached && Array.isArray(cached.cards)) {
        state.cards = cached.cards;
        renderCatalog();
        const date = cached.savedAt ? new Date(cached.savedAt).toLocaleDateString() : 'an earlier session';
        $('#sync-status').textContent = `Offline catalog · cached ${date}`;
      }
    } catch (error) {
      console.warn('Could not read cached card catalog:', error);
    }
  }

  async function loadCatalog() {
    if (state.loading) return;
    state.loading = true;
    $('#refresh-button').disabled = true;
    $('#sidebar-sync-dot').classList.remove('live');
    $('#sync-status').textContent = 'Loading live card catalog…';
    $('#result-count').textContent = 'Connecting to card catalog…';
    if (!state.cards.length) renderCatalog();
    try {
      const cards = [];
      let page = 1;
      let totalCount = Infinity;
      while (cards.length < totalCount) {
        const url = new URL(API);
        url.searchParams.set('q', 'name:Lucario');
        url.searchParams.set('pageSize', '250');
        url.searchParams.set('page', String(page));
        url.searchParams.set('orderBy', '-set.releaseDate');
        const response = await fetch(url, { headers: { Accept: 'application/json' }, cache: 'no-cache' });
        if (!response.ok) throw new Error(`Card API returned HTTP ${response.status}`);
        const payload = await response.json();
        if (!Array.isArray(payload.data)) throw new Error('Card API returned an unexpected response.');
        totalCount = Number.isFinite(payload.totalCount) ? payload.totalCount : payload.data.length;
        cards.push(...payload.data);
        if (payload.data.length === 0 || payload.data.length < 250) break;
        page += 1;
      }
      if (cards.length === 0) throw new Error('The card catalog returned no Lucario prints.');
      state.cards = cards;
      cacheCards(cards);
      $('#sync-status').textContent = `Live · ${cards.length} prints from Pokémon TCG API`;
      $('#sidebar-sync-dot').classList.add('live');
      renderCatalog();
    } catch (error) {
      console.error('Live card catalog could not be loaded:', error);
      $('#sync-status').textContent = state.cards.length
        ? 'Offline · showing the last cached catalog'
        : 'Card catalog unavailable · check your connection and try again';
      $('#sidebar-sync-dot').classList.remove('live');
      if (!state.cards.length) {
        $('#result-count').textContent = 'Could not connect to the live card catalog.';
        $('#empty-title').textContent = 'Catalog unavailable';
        $('#empty-copy').textContent = 'Your saved collection is safe on this device. Check your connection and refresh to load Lucario cards.';
        $('#empty-action').textContent = 'Try again';
      }
      showToast(state.cards.length ? 'Live catalog unavailable; showing cached data.' : 'Could not load the live catalog.');
    } finally {
      state.loading = false;
      $('#refresh-button').disabled = false;
      renderCatalog();
    }
  }

  function variantOptions(card) {
    const keys = new Set(Object.keys(card.tcgplayer?.prices || {}));
    keys.add('normal');
    return [...keys].map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(displayVariant(key))}${cardPrice(card, key) === null ? ' · no quote' : ''}</option>`).join('') +
      '<option value="custom">Other / special treatment…</option>';
  }

  function updateDialogPrice() {
    const variant = $('#variant-select').value;
    const key = variant === 'custom' ? keyForVariant($('#custom-variant').value) : variant;
    const amount = state.dialogCard ? cardPrice(state.dialogCard, key) : null;
    const priceLabel = amount === null ? 'Unavailable' : formatMoney(amount);
    $('#dialog-market-value').textContent = `${priceLabel}${amount !== null && isStale(state.dialogCard) ? ' · stale' : ''}`;
  }

  function cardSearchQuery(card, variant) {
    return [card.name, card.set?.name, card.number ? `#${card.number}` : '', variant, 'Pokemon TCG']
      .filter(Boolean)
      .join(' ');
  }

  function updatePriceLinks() {
    const card = state.pricesCard;
    if (!card) return;
    const variant = $('#prices-variant').value;
    const query = cardSearchQuery(card, variant);
    const encoded = encodeURIComponent(query);
    const amount = cardPrice(card, variant);
    const updatedAt = card.tcgplayer?.updatedAt;
    $('#api-source-price').textContent = amount === null
      ? 'Unavailable for this treatment'
      : `${formatMoney(amount)}${isStale(card) ? ' · stale' : ''}`;
    $('#api-source-note').textContent = amount === null
      ? 'No market quote is available for the selected print treatment.'
      : `TCGplayer market estimate · USD${updatedAt ? ` · updated ${new Date(updatedAt).toLocaleDateString()}` : ''}. This is a market estimate, not a live listing.`;
    const directTcgplayerUrl = state.data.tcgplayerLinks?.[card.id];
    const tcgplayerLink = $('#tcgplayer-link');
    tcgplayerLink.href = validTcgplayerProductUrl(directTcgplayerUrl || '') ? directTcgplayerUrl : '#';
    tcgplayerLink.textContent = validTcgplayerProductUrl(directTcgplayerUrl || '')
      ? 'Open exact card on TCGplayer ↗'
      : 'Exact product link not set';
    tcgplayerLink.classList.toggle('source-link-disabled', !validTcgplayerProductUrl(directTcgplayerUrl || ''));
    tcgplayerLink.setAttribute('aria-disabled', String(!validTcgplayerProductUrl(directTcgplayerUrl || '')));
    tcgplayerLink.tabIndex = validTcgplayerProductUrl(directTcgplayerUrl || '') ? 0 : -1;
    $('#tcgplayer-product-url').value = validTcgplayerProductUrl(directTcgplayerUrl || '') ? directTcgplayerUrl : '';
    $('#pricecharting-link').href = `https://www.pricecharting.com/search-products?type=prices&q=${encoded}`;
    $('#ebay-sold-link').href = `https://www.ebay.com/sch/i.html?_nkw=${encoded}&_sacat=0&LH_Sold=1&LH_Complete=1`;
    $('#ebay-active-link').href = `https://www.ebay.com/sch/i.html?_nkw=${encoded}&_sacat=0`;
  }

  function openPricesDialog(card) {
    state.pricesCard = card;
    $('#prices-title').textContent = `Compare ${card.name} prices`;
    $('#prices-card-details').textContent = `${card.set?.name || 'Set unavailable'} · #${card.number || '?'} · ${card.rarity || 'Rarity not listed'}`;
    const keys = [...new Set([...Object.keys(card.tcgplayer?.prices || {}), 'normal'])];
    $('#prices-variant').innerHTML = keys.map((key) =>
      `<option value="${escapeHtml(key)}">${escapeHtml(displayVariant(key))}</option>`
    ).join('');
    $('#prices-dialog').showModal();
    updatePriceLinks();
  }

  function saveTcgplayerProductLink() {
    const card = state.pricesCard;
    const input = $('#tcgplayer-product-url');
    const value = input.value.trim();
    if (!card) return;
    if (!validTcgplayerProductUrl(value)) {
      input.setCustomValidity('Paste an HTTPS TCGplayer product page URL, such as https://www.tcgplayer.com/product/123456/...');
      input.reportValidity();
      return;
    }
    input.setCustomValidity('');
    const previous = state.data.tcgplayerLinks[card.id];
    state.data.tcgplayerLinks[card.id] = value;
    if (!saveData()) {
      if (previous) state.data.tcgplayerLinks[card.id] = previous;
      else delete state.data.tcgplayerLinks[card.id];
      return;
    }
    updatePriceLinks();
    showToast('Exact TCGplayer product link saved on this device.');
  }

  function openDetailsDialog(card) {
    const ownedEntries = state.data.owned.map((item, index) => ({ item, index })).filter(({ item }) => item.cardId === card.id);
    const market = cardPrice(card, pricesFor(card)[0] || 'normal');
    const art = card.images?.large || card.images?.small;
    const alternatePrints = state.cards
      .filter((candidate) => candidate.id !== card.id && candidate.name === card.name)
      .sort((a, b) => (b.set?.releaseDate || '').localeCompare(a.set?.releaseDate || ''));
    const alternateMarkup = alternatePrints.length
      ? `<div class="alternate-print-grid">${alternatePrints.map((print) => {
        const printArt = print.images?.small || print.images?.large;
        const printPrice = cardPrice(print, pricesFor(print)[0] || 'normal');
        return `<button class="alternate-print ${rarityClass(print)}" type="button" data-action="alternate-print" data-card-id="${escapeAttribute(print.id)}">
          <span class="alternate-print-art">${printArt ? `<img class="card-art" src="${escapeAttribute(printArt)}" alt="" loading="lazy">` : '<span class="no-art">L</span>'}</span>
          <span class="alternate-print-info"><strong>${escapeHtml(print.rarity || 'Rarity not listed')}</strong><span>${escapeHtml(print.set?.name || 'Set unavailable')} · #${escapeHtml(print.number || '?')}</span><span class="alternate-print-price">${printPrice === null ? 'Price unavailable' : formatMoney(printPrice)}</span></span>
          <span class="alternate-print-arrow" aria-hidden="true">↗</span>
        </button>`;
      }).join('')}</div>`
      : '<div class="empty-inline">No additional printings of this exact card name are listed in the current catalog.</div>';
    const entryMarkup = ownedEntries.length ? ownedEntries.map(({ item, index }) => {
      const paid = item.copies.reduce((sum, copy) => sum + Number(copy.paid || 0), 0);
      const entryPrice = cardPrice(card, keyForVariant(item.variant));
      return `<section class="detail-entry">
        <h3>${escapeHtml(item.variant)} · ${escapeHtml(item.condition)} · ${item.copies.length} ${item.copies.length === 1 ? 'copy' : 'copies'}</h3>
        <div class="detail-metrics"><div class="detail-metric"><span>ACQUISITION · TOTAL PAID</span><strong>${formatMoney(paid)}</strong></div><div class="detail-metric"><span>EST. MARKET · PER COPY</span><strong>${entryPrice === null ? 'Unavailable' : formatMoney(entryPrice)}</strong></div></div>
        ${item.note ? `<p>Note: ${escapeHtml(item.note)}</p>` : ''}
        <div class="detail-actions"><button class="button button-secondary" type="button" data-action="edit-entry" data-card-id="${escapeAttribute(card.id)}" data-group-index="${index}">Edit details</button><button class="button detail-delete" type="button" data-action="delete-entry" data-card-id="${escapeAttribute(card.id)}" data-group-index="${index}">Delete entry</button></div>
      </section>`;
    }).join('') : '<div class="empty-inline">Not in your collection yet. Add it to record condition, acquisition price, and notes.</div>';
    $('#detail-content').innerHTML = `<div class="detail-hero">
      <div class="detail-art-wrap">${art ? `<img class="detail-art" src="${escapeAttribute(art)}" alt="${escapeAttribute(card.name)} card artwork">` : '<div class="no-art">L</div>'}</div>
      <div class="detail-meta"><div class="dialog-eyebrow">${escapeHtml(card.rarity || 'CARD DETAILS')}</div><h2>${escapeHtml(card.name)}</h2><p>${escapeHtml(card.set?.name || 'Set unavailable')} · #${escapeHtml(card.number || '?')}</p>
        <div class="detail-metrics"><div class="detail-metric"><span>MARKET ESTIMATE</span><strong>${market === null ? 'Unavailable' : formatMoney(market)}</strong></div><div class="detail-metric"><span>COLLECTION</span><strong>${ownedEntries.reduce((sum, { item }) => sum + item.copies.length, 0)} owned</strong></div></div>
      </div></div>
      <div class="detail-actions"><button class="button button-primary" type="button" data-action="detail-add" data-card-id="${escapeAttribute(card.id)}">＋ Add to collection</button><button class="button button-secondary" type="button" data-action="detail-price" data-card-id="${escapeAttribute(card.id)}">Compare prices</button><button class="button button-secondary" type="button" data-action="detail-wishlist" data-card-id="${escapeAttribute(card.id)}">${cardWished(card.id) ? '♥ On wishlist' : '♡ Add to wishlist'}</button></div>
      <h3 class="detail-section-title">Other printings & rarities <span class="detail-variant-count">${alternatePrints.length}</span></h3>
      <p class="detail-variant-note">Same card name across the available Lucario catalog. Each printing shows its listed rarity, including Secret Rare when available.</p>
      ${alternateMarkup}
      <h3 class="detail-section-title">Your copies</h3>${entryMarkup}`;
    $('#detail-dialog').showModal();
  }

  function openCardDialog(card, action, groupIndex = null) {
    state.dialogCard = card;
    state.editingGroupIndex = action === 'edit' ? groupIndex : null;
    $('#dialog-action').value = action;
    $('#dialog-card-id').value = card.id;
    $('#dialog-card-name').textContent = `${card.name} · ${card.set?.name || 'Set unavailable'} · #${card.number || '?'}`;
    const editing = action === 'edit' && Number.isInteger(groupIndex) && state.data.owned[groupIndex];
    $('#dialog-eyebrow').textContent = action === 'wishlist' ? 'WISHLIST' : editing ? 'EDIT COLLECTION ENTRY' : 'COLLECTION';
    $('#dialog-title').textContent = action === 'wishlist' ? 'Add to wishlist' : editing ? 'Edit card details' : 'Add to collection';
    $('#dialog-submit').textContent = action === 'wishlist' ? 'Save to wishlist' : editing ? 'Save changes' : 'Add card';
    $('#condition-fields').hidden = action === 'wishlist';
    $('#budget-check').closest('.check-label').hidden = Boolean(editing);
    $('#paid-label').innerHTML = editing
      ? 'Price paid · first copy <span class="field-optional">USD</span>'
      : 'Price paid <span class="field-optional">optional · USD</span>';
    $('#duplicate-warning').hidden = true;
    $('#paid-input').value = editing ? String(editing.copies[0]?.paid || '') : '';
    $('#budget-check').checked = true;
    $('#notes-input').value = editing?.note || '';
    $('#variant-select').innerHTML = variantOptions(card);
    if (editing) {
      const existingKey = keyForVariant(editing.variant);
      if ([...$('#variant-select').options].some((option) => option.value === existingKey)) $('#variant-select').value = existingKey;
      else {
        $('#variant-select').value = 'custom';
        $('#custom-variant').value = editing.variant;
      }
      $('#condition-select').value = editing.condition;
    } else {
      $('#custom-variant').value = '';
      $('#condition-select').value = 'Near Mint';
    }
    const customSelected = $('#variant-select').value === 'custom';
    $('#custom-variant-label').hidden = !customSelected;
    $('#custom-variant').hidden = !customSelected;
    $('#custom-variant-note').hidden = !customSelected;
    $('#card-dialog').showModal();
    updateDialogPrice();
  }

  function addOwned(card, variant, condition, paid, countBudget) {
    let group = state.data.owned.find((item) =>
      item.cardId === card.id && item.variant === variant && item.condition === condition);
    const isNewGroup = !group;
    const previousNote = group?.note;
    if (group) {
      const confirmed = window.confirm(`You already have ${group.copies.length} ${condition} ${variant} ${card.name} card${group.copies.length === 1 ? '' : 's'}. Add another copy?`);
      if (!confirmed) return false;
      group.copies.push({ paid, addedAt: new Date().toISOString() });
      if ($('#notes-input').value.trim()) group.note = $('#notes-input').value.trim();
    } else {
      group = {
        cardId: card.id,
        variant,
        verifiedVariant: Object.hasOwn(card.tcgplayer?.prices || {}, keyForVariant(variant)),
        condition,
        note: $('#notes-input').value.trim(),
        copies: [{ paid, addedAt: new Date().toISOString() }]
      };
      state.data.owned.push(group);
    }
    if (countBudget && paid > 0) {
      const now = new Date();
      state.data.expenses.push({ id: crypto.randomUUID(), amount: paid, note: `${card.name} · ${variant}`, date: now.toISOString(), month: localMonth(now) });
    }
    if (!saveData()) {
      if (isNewGroup) state.data.owned.pop();
      else {
        group.copies.pop();
        group.note = previousNote;
      }
      if (countBudget && paid > 0) state.data.expenses.pop();
      return false;
    }
    return true;
  }

  function addWishlist(card, variant) {
    const exists = state.data.wishlist.some((item) => item.cardId === card.id && item.variant === variant);
    if (exists) {
      showToast('That print and treatment are already on your wishlist.');
      return false;
    }
    const entry = {
      cardId: card.id,
      variant,
      verifiedVariant: Object.hasOwn(card.tcgplayer?.prices || {}, keyForVariant(variant)),
      addedAt: new Date().toISOString()
    };
    state.data.wishlist.push(entry);
    if (!saveData()) {
      state.data.wishlist.pop();
      return false;
    }
    return true;
  }

  function markMissing(cardId) {
    const card = currentCard(cardId);
    const copies = state.data.owned.filter((entry) => entry.cardId === cardId)
      .reduce((sum, entry) => sum + entry.copies.length, 0);
    if (!copies) return;
    const confirmed = window.confirm(`Mark ${card?.name || 'this print'} as missing? This removes all ${copies} saved ${copies === 1 ? 'copy' : 'copies'} from your collection.`);
    if (!confirmed) return;
    const previousOwned = state.data.owned;
    state.data.owned = previousOwned.filter((entry) => entry.cardId !== cardId);
    if (!saveData()) {
      state.data.owned = previousOwned;
      return;
    }
    renderCatalog();
    showToast(`${card?.name || 'Card'} marked missing.`);
  }

  function removeWishlist(cardId) {
    const item = state.data.wishlist.find((entry) => entry.cardId === cardId);
    if (!item) return;
    const confirmed = window.confirm(`Remove ${currentCard(cardId)?.name || 'this card'} from your wishlist?`);
    if (!confirmed) return;
    const previousWishlist = state.data.wishlist;
    state.data.wishlist = previousWishlist.filter((entry) => entry !== item);
    if (!saveData()) {
      state.data.wishlist = previousWishlist;
      return;
    }
    renderCatalog();
  }

  function toggleFavorite(cardId) {
    const hadFavorite = isFavorite(cardId);
    state.data.favorites = hadFavorite
      ? state.data.favorites.filter((id) => id !== cardId)
      : [...state.data.favorites, cardId];
    if (!saveData()) {
      state.data.favorites = hadFavorite
        ? [...state.data.favorites, cardId]
        : state.data.favorites.filter((id) => id !== cardId);
      return;
    }
    renderCatalog();
    showToast(hadFavorite ? 'Removed from featured favorites.' : 'Added to featured favorites.');
  }

  function deleteOwnedEntry(groupIndex) {
    const item = state.data.owned[groupIndex];
    if (!item) {
      showToast('That collection entry could not be found.');
      return;
    }
    const card = currentCard(item.cardId);
    if (!window.confirm(`Delete ${card?.name || 'this card'} · ${item.variant} · ${item.condition} (${item.copies.length} ${item.copies.length === 1 ? 'copy' : 'copies'}) from your collection?`)) return;
    const [removed] = state.data.owned.splice(groupIndex, 1);
    if (!saveData()) {
      state.data.owned.splice(groupIndex, 0, removed);
      return;
    }
    $('#detail-dialog').close();
    renderCatalog();
    showToast('Collection entry deleted.');
  }

  async function importDataFile(file) {
    if (!file) return;
    try {
      const imported = JSON.parse(await file.text());
      if (!imported || !Array.isArray(imported.owned) || !Array.isArray(imported.wishlist) || !Array.isArray(imported.expenses)) {
        throw new Error('This file is not a valid Aura Vault collection backup.');
      }
      const previous = JSON.parse(JSON.stringify(state.data));
      const signature = (copy) => `${copy.addedAt || ''}|${Number(copy.paid || 0)}`;
      for (const incoming of imported.owned) {
        if (!incoming || typeof incoming.cardId !== 'string' || typeof incoming.variant !== 'string' ||
            typeof incoming.condition !== 'string' || !Array.isArray(incoming.copies)) continue;
        let existing = state.data.owned.find((entry) => entry.cardId === incoming.cardId &&
          entry.variant === incoming.variant && entry.condition === incoming.condition);
        if (!existing) {
          existing = { ...incoming, copies: [] };
          state.data.owned.push(existing);
        }
        const knownCopies = new Set(existing.copies.map(signature));
        for (const copy of incoming.copies) {
          if (copy && !knownCopies.has(signature(copy))) {
            existing.copies.push(copy);
            knownCopies.add(signature(copy));
          }
        }
        if (!existing.note && incoming.note) existing.note = incoming.note;
      }
      for (const incoming of imported.wishlist) {
        if (incoming && typeof incoming.cardId === 'string' && typeof incoming.variant === 'string' &&
            !state.data.wishlist.some((entry) => entry.cardId === incoming.cardId && entry.variant === incoming.variant)) {
          state.data.wishlist.push(incoming);
        }
      }
      const expenseKeys = new Set(state.data.expenses.map((item) => item.id || `${item.date}|${item.amount}|${item.note}`));
      for (const incoming of imported.expenses) {
        if (!incoming || !Number.isFinite(Number(incoming.amount))) continue;
        const key = incoming.id || `${incoming.date}|${incoming.amount}|${incoming.note}`;
        if (!expenseKeys.has(key)) {
          state.data.expenses.push(incoming);
          expenseKeys.add(key);
        }
      }
      const favoriteIds = new Set(state.data.favorites);
      for (const cardId of Array.isArray(imported.favorites) ? imported.favorites : []) {
        if (typeof cardId === 'string') favoriteIds.add(cardId);
      }
      state.data.favorites = [...favoriteIds];
      for (const [cardId, url] of Object.entries(imported.tcgplayerLinks || {})) {
        if (typeof url === 'string' && validTcgplayerProductUrl(url)) {
          state.data.tcgplayerLinks[cardId] = url;
        }
      }
      if (!saveData()) {
        state.data = previous;
        return;
      }
      renderCatalog();
      showToast('Backup imported and merged with your existing vault.');
    } catch (error) {
      console.error('Could not import collection backup:', error);
      showToast(error instanceof SyntaxError ? 'Could not read backup: invalid JSON.' : error.message || 'Could not import this backup.');
    } finally {
      $('#import-file').value = '';
    }
  }

  function exportData() {
    const contents = JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), ...state.data }, null, 2);
    const url = URL.createObjectURL(new Blob([contents], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = `lucario-ledger-${new Date().toISOString().slice(0, 10)}.json`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('Your collection data has been exported.');
  }

  function submitCardForm(event) {
    event.preventDefault();
    const card = currentCard($('#dialog-card-id').value);
    if (!card) {
      showToast('This card is no longer in the loaded catalog. Refresh and try again.');
      return;
    }
    const action = $('#dialog-action').value;
    const selected = $('#variant-select').value;
    const custom = $('#custom-variant').value.trim();
    if (selected === 'custom' && !custom) {
      $('#custom-variant').focus();
      showToast('Describe the special treatment before saving.');
      return;
    }
    const variant = selected === 'custom' ? custom : displayVariant(selected);
    let changed;
    if (action === 'owned' || action === 'edit') {
      const paid = Number($('#paid-input').value || 0);
      if (!Number.isFinite(paid) || paid < 0) {
        showToast('Enter a valid purchase price.');
        return;
      }
      if (action === 'owned') {
        changed = addOwned(card, variant, $('#condition-select').value, paid, $('#budget-check').checked);
      } else {
      const index = state.editingGroupIndex;
      const existing = Number.isInteger(index) ? state.data.owned[index] : null;
      if (!existing) {
        showToast('That collection entry could not be found.');
        return;
      }
      const duplicate = state.data.owned.some((entry, entryIndex) => entryIndex !== index &&
        entry.cardId === card.id && entry.variant === variant && entry.condition === $('#condition-select').value);
      if (duplicate) {
        showToast('An identical card, treatment, and condition entry already exists. Edit that entry instead.');
        return;
      }
      const previous = JSON.parse(JSON.stringify(existing));
      existing.variant = variant;
      existing.verifiedVariant = Object.hasOwn(card.tcgplayer?.prices || {}, keyForVariant(variant));
      existing.condition = $('#condition-select').value;
      existing.note = $('#notes-input').value.trim();
      if (existing.copies.length) existing.copies[0].paid = paid;
      changed = saveData();
      if (!changed) state.data.owned[index] = previous;
      }
    } else {
      changed = addWishlist(card, variant);
    }
    if (changed) {
      $('#card-dialog').close();
      renderCatalog();
      showToast(action === 'owned' ? 'Card added to your collection.' : action === 'edit' ? 'Collection entry updated.' : 'Card added to your wishlist.');
    }
  }

  function bindEvents() {
    document.querySelectorAll('.tab').forEach((tab) => tab.addEventListener('click', () => setView(tab.dataset.view)));
    document.querySelectorAll('[data-nav]').forEach((button) => button.addEventListener('click', (event) => {
      event.preventDefault();
      navigateTo(button.dataset.nav);
    }));
    $('#search-input').addEventListener('input', (event) => {
      state.query = event.target.value;
      $('#collection-search').value = state.query;
      renderCatalog();
    });
    $('#collection-search').addEventListener('input', (event) => {
      state.query = event.target.value;
      $('#search-input').value = state.query;
      renderCatalog();
    });
    $('#sort-select').addEventListener('change', (event) => { state.sort = event.target.value; renderCatalog(); });
    $('#rarity-filter').addEventListener('change', (event) => { state.filters.rarity = event.target.value; renderCatalog(); });
    $('#condition-filter').addEventListener('change', (event) => { state.filters.condition = event.target.value; renderCatalog(); });
    $('#language-filter').addEventListener('change', (event) => { state.filters.language = event.target.value; renderCatalog(); });
    $('#type-filter').addEventListener('change', (event) => { state.filters.type = event.target.value; renderCatalog(); });
    $('#refresh-button').addEventListener('click', loadCatalog);
    $('#browse-button').addEventListener('click', () => navigateTo('collection'));
    $('#collection-add-button').addEventListener('click', () => navigateTo('collection'));
    $('#export-button').addEventListener('click', exportData);
    $('#import-button').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (event) => importDataFile(event.target.files[0]));
    $('#mobile-more-button').addEventListener('click', exportData);
    $('#empty-action').addEventListener('click', () => {
      if (state.view !== 'all' && state.cards.length) setView('all');
      else loadCatalog();
    });
    $('#catalog-grid').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const card = currentCard(button.dataset.cardId);
      if (!card) return;
      if (button.dataset.action === 'details') openDetailsDialog(card);
      if (button.dataset.action === 'owned') openCardDialog(card, 'owned');
      if (button.dataset.action === 'missing') markMissing(card.id);
      if (button.dataset.action === 'favorite') toggleFavorite(card.id);
      if (button.dataset.action === 'wishlist') {
        if (cardWished(card.id)) removeWishlist(card.id);
        else openCardDialog(card, 'wishlist');
      }
    });
    for (const grid of ['#recent-grid', '#favorites-grid', '#wishlist-highlights']) {
      $(grid).addEventListener('click', (event) => {
        const button = event.target.closest('[data-action="details"]');
        const card = button ? currentCard(button.dataset.cardId) : null;
        if (card) openDetailsDialog(card);
      });
    }
    $('#detail-content').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const card = currentCard(button.dataset.cardId);
      if (!card) return;
      if (button.dataset.action === 'alternate-print') {
        openDetailsDialog(card);
      } else if (button.dataset.action === 'detail-price') {
        $('#detail-dialog').close();
        openPricesDialog(card);
      } else if (button.dataset.action === 'detail-add') {
        $('#detail-dialog').close();
        openCardDialog(card, 'owned');
      } else if (button.dataset.action === 'detail-wishlist') {
        $('#detail-dialog').close();
        if (cardWished(card.id)) removeWishlist(card.id);
        else openCardDialog(card, 'wishlist');
      } else if (button.dataset.action === 'edit-entry') {
        $('#detail-dialog').close();
        openCardDialog(card, 'edit', Number(button.dataset.groupIndex));
      } else if (button.dataset.action === 'delete-entry') {
        deleteOwnedEntry(Number(button.dataset.groupIndex));
      }
    });
    $('#variant-select').addEventListener('change', () => {
      const isCustom = $('#variant-select').value === 'custom';
      $('#custom-variant-label').hidden = !isCustom;
      $('#custom-variant').hidden = !isCustom;
      $('#custom-variant-note').hidden = !isCustom;
      updateDialogPrice();
      if (isCustom) $('#custom-variant').focus();
    });
    $('#custom-variant').addEventListener('input', updateDialogPrice);
    $('#prices-variant').addEventListener('change', updatePriceLinks);
    $('#tcgplayer-product-url').addEventListener('input', (event) => event.target.setCustomValidity(''));
    $('#save-tcgplayer-link').addEventListener('click', saveTcgplayerProductLink);
    $('#card-form').addEventListener('submit', submitCardForm);
    $('#spend-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const amount = Number($('#spend-amount').value);
      if (!Number.isFinite(amount) || amount <= 0) {
        showToast('Enter a purchase amount greater than zero.');
        return;
      }
      const now = new Date();
      state.data.expenses.push({
        id: crypto.randomUUID(),
        amount,
        note: $('#spend-note').value.trim(),
        date: now.toISOString(),
        month: localMonth(now)
      });
      if (!saveData()) {
        state.data.expenses.pop();
        return;
      }
      $('#spend-dialog').close();
      $('#spend-form').reset();
      renderCatalog();
      showToast('Purchase logged to this month’s budget.');
    });
    $('#log-spend-button').addEventListener('click', () => $('#spend-dialog').showModal());
    document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => button.closest('dialog').close()));
    document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => {
      if (event.target === dialog) dialog.close();
    }));
    document.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        $('#search-input').focus();
      }
    });
    document.addEventListener('error', (event) => {
      const image = event.target;
      if (!(image instanceof HTMLImageElement) || (!image.classList.contains('card-art') && !image.classList.contains('detail-art'))) return;
      const fallback = document.createElement('span');
      fallback.className = 'no-art';
      fallback.setAttribute('role', 'img');
      fallback.setAttribute('aria-label', 'Card artwork unavailable');
      fallback.textContent = 'L';
      image.replaceWith(fallback);
    }, true);
  }

  restoreCatalogCache();
  bindEvents();
  renderCatalog();
  loadCatalog();
})();
