(() => {
  'use strict';

  const API = 'https://api.pokemontcg.io/v2/cards';
  const POKEDEX_API = 'https://pokeapi.co/api/v2/pokedex/1';
  const CACHE_KEY = 'lucario-ledger.catalog.v1';
  const CATALOG_CACHE_PREFIX = `${CACHE_KEY}.pokemon.`;
  const CATALOG_CACHE_INDEX_KEY = `${CACHE_KEY}.index`;
  const WISHLIST_CARD_CACHE_KEY = `${CACHE_KEY}.wishlist`;
  const MAX_CACHED_CATALOGS = 4;
  const CATALOG_RETRY_LIMIT = 3;
  const CATALOG_TIMEOUT_MS = 20000;
  const SPECIES_CACHE_KEY = 'lucario-ledger.species.v1';
  const DATA_KEY = 'lucario-ledger.data.v1';
  const DEFAULT_MONTHLY_BUDGET = 50;
  const STALE_AFTER_DAYS = 7;
  let storedDataUnreadable = false;
  const state = {
    cards: [],
    scannedCards: [],
    wishlistCards: [],
    ownedCards: [],
    ownedLoading: false,
    ownedLoadPromise: null,
    ownedReloadRequested: false,
    ownedUnavailableIds: [],
    wishlistLoading: false,
    wishlistLoadPromise: null,
    wishlistReloadRequested: false,
    wishlistUnavailableIds: [],
    species: [],
    speciesByName: [],
    selectedPokemon: 'lucario',
    data: loadData(),
    pendingImport: null,
    view: 'all',
    query: '',
    sort: 'date-added',
    filters: { rarity: '', language: '', type: '', set: '', pokemon: '', ownership: '', condition: '', favorites: '', wishlist: '' },
    filteredCount: 0,
    filterTotal: 0,
    loading: false,
    catalogLoaded: false,
    lastCatalogSuccessAt: 0,
    cameraStream: null,
    scanWorker: null,
    scanImage: null,
    scanOriginalDataUrl: '',
    scanRotation: 0,
    scanCropPercent: 0,
    scanTorchEnabled: false,
    scanRunning: false,
    scanQueue: [],
    scanRescanQueueId: '',
    dialogCard: null,
    pricesCard: null,
    editingGroupIndex: null,
    editingWishlistIndex: null,
    savingCard: false,
    toastTimer: null
  };
  const $ = (selector) => document.querySelector(selector);

  function loadData() {
    try {
      const raw = localStorage.getItem(DATA_KEY);
      const parsed = raw ? validateBackupPayload(JSON.parse(raw)) : {};
      return {
        ...parsed,
        owned: Array.isArray(parsed.owned) ? parsed.owned : [],
        wishlist: Array.isArray(parsed.wishlist) ? parsed.wishlist : [],
        expenses: Array.isArray(parsed.expenses) ? parsed.expenses : [],
        monthlyBudget: Number.isFinite(parsed.monthlyBudget) && parsed.monthlyBudget >= 0
          ? parsed.monthlyBudget : DEFAULT_MONTHLY_BUDGET,
        favorites: Array.isArray(parsed.favorites) ? parsed.favorites : [],
        tcgplayerLinks: parsed.tcgplayerLinks && typeof parsed.tcgplayerLinks === 'object' &&
          !Array.isArray(parsed.tcgplayerLinks) ? parsed.tcgplayerLinks : {}
      };
    } catch (error) {
      console.error('Could not read saved collection data:', error);
      storedDataUnreadable = true;
      return { owned: [], wishlist: [], expenses: [], monthlyBudget: DEFAULT_MONTHLY_BUDGET, favorites: [] };
    }
  }

  function saveData() {
    if (storedDataUnreadable) {
      showToast('Saved data could not be read. No changes were written to avoid overwriting it.');
      return false;
    }
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
    return Object.keys(prices).filter((key) => cardPrice(card, key) !== null);
  }

  function primaryVariant(card) {
    return pricesFor(card)[0] || 'normal';
  }

  function cardSetNumber(card) {
    if (!card?.number) return null;
    const printedTotal = card.set?.printedTotal;
    return Number.isInteger(printedTotal) && printedTotal > 0
      ? `${card.number}/${printedTotal}`
      : String(card.number);
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

  function localDateInputValue(date = new Date()) {
    return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  }

  function dateForInput(value) {
    if (!value) return localDateInputValue();
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
    const date = new Date(value);
    return Number.isFinite(date.getTime()) ? localDateInputValue(date) : localDateInputValue();
  }

  function isoForLocalDate(value) {
    const [year, month, day] = value.split('-').map(Number);
    return new Date(year, month - 1, day, 12).toISOString();
  }

  function currentCard(id) {
    return state.cards.find((card) => card.id === id) ||
      state.ownedCards.find((card) => card.id === id) ||
      state.wishlistCards.find((card) => card.id === id) ||
      state.scannedCards.find((card) => card.id === id) || null;
  }

  function cardLanguage(card) {
    return card.language || card.set?.language || 'English';
  }

  function canonicalLanguage(value) {
    const normalized = String(value || '').trim().toLowerCase().replace(/_/g, '-');
    const languages = {
      en: 'english', english: 'english',
      ja: 'japanese', japanese: 'japanese',
      fr: 'french', french: 'french',
      de: 'german', german: 'german',
      it: 'italian', italian: 'italian',
      es: 'spanish', spanish: 'spanish',
      pt: 'portuguese', portuguese: 'portuguese',
      ko: 'korean', korean: 'korean',
      'zh-cn': 'simplified chinese', 'simplified chinese': 'simplified chinese',
      'zh-tw': 'traditional chinese', 'traditional chinese': 'traditional chinese'
    };
    return languages[normalized] || normalized;
  }

  function displayLanguage(value) {
    const labels = {
      english: 'English',
      japanese: 'Japanese',
      french: 'French',
      german: 'German',
      italian: 'Italian',
      spanish: 'Spanish',
      portuguese: 'Portuguese',
      korean: 'Korean',
      'simplified chinese': 'Simplified Chinese',
      'traditional chinese': 'Traditional Chinese'
    };
    return labels[canonicalLanguage(value)] || String(value || '').trim();
  }

  function cardPokemonId(card) {
    const normalize = (value) => value.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
    const ownedPokemon = state.data.owned.find((item) => item.cardId === card.id)?.pokemon;
    if (typeof ownedPokemon === 'string' && ownedPokemon) {
      return state.species.find((species) =>
        species.name === ownedPokemon.toLowerCase() ||
        normalize(formatPokemonName(species.name)) === normalize(ownedPokemon))?.name ||
        ownedPokemon.toLowerCase().replace(/[^a-z0-9-]/g, '-');
    }
    const wishlistPokemon = state.data.wishlist.find((item) => item.cardId === card.id)?.pokemon;
    if (typeof wishlistPokemon === 'string' && wishlistPokemon) return wishlistPokemon;
    if (state.cards.some((item) => item.id === card.id)) return state.selectedPokemon;
    const cardName = normalize(card.name || '');
    return state.speciesByName.find((species) => {
        const name = normalize(formatPokemonName(species.name));
        return name.length > 2 && cardName.includes(name);
      })?.name || '';
  }

  function resultCards() {
    if (state.view === 'wishlist') {
      return [...new Map([...state.cards, ...state.wishlistCards].map((card) => [card.id, card])).values()];
    }
    if (state.view === 'owned') {
      return [...new Map([...state.cards, ...state.ownedCards].map((card) => [card.id, card])).values()];
    }
    return state.cards;
  }

  function ownedFallbackCard(cardId) {
    const entry = state.data.owned.find((item) => item.cardId === cardId);
    if (!entry) return null;
    return {
      id: cardId,
      name: entry.cardName || cardId,
      number: entry.cardNumber || '',
      rarity: entry.rarity || '',
      lang: entry.language || '',
      set: { name: entry.setName || 'Saved card · details unavailable' },
      images: {},
      _savedDetailsOnly: true
    };
  }

  function formatPokemonName(name) {
    const specialNames = {
      farfetchd: "Farfetch'd",
      flabebe: 'Flabébé',
      'mime-jr': 'Mime Jr.',
      'mr-mime': 'Mr. Mime',
      'mr-rime': 'Mr. Rime',
      'nidoran-f': 'Nidoran♀',
      'nidoran-m': 'Nidoran♂',
      'type-null': 'Type: Null'
    };
    if (specialNames[name]) return specialNames[name];
    return name.split('-').map((part) => part ? `${part[0].toUpperCase()}${part.slice(1)}` : '').join('-');
  }

  function pokedexNumber(species) {
    if (Number.isInteger(species?.number) && species.number > 0) return species.number;
    const match = species?.url?.match(/\/(\d+)\/?$/);
    return match ? Number(match[1]) : null;
  }

  function selectedPokemonName() {
    return formatPokemonName(state.selectedPokemon);
  }

  function pokemonSearchTerm(name) {
    const aliases = {
      farfetchd: "farfetch'd",
      flabebe: 'flabébé',
      'mime-jr': 'mime jr.',
      'mr-mime': 'mr. mime',
      'mr-rime': 'mr. rime',
      'nidoran-f': 'nidoran♀',
      'nidoran-m': 'nidoran♂',
      'type-null': 'type: null'
    };
    return aliases[name] || name;
  }

  function cardValue(cardId, variant) {
    const card = currentCard(cardId);
    const key = keyForVariant(variant);
    return card ? cardPrice(card, key) : null;
  }

  function refreshOverview() {
    const uniqueOwned = new Set(state.cards.filter((card) => cardOwned(card.id) > 0).map((card) => card.id)).size;
    const allOwnedPrints = totalOwnedPrints();
    const total = state.cards.length;
    const visibleOwned = state.data.owned.filter((item) => currentCard(item.cardId));
    const ownedValue = visibleOwned.reduce((sum, item) => {
      const value = cardValue(item.cardId, item.variant);
      return sum + (value === null ? 0 : value * item.copies.length);
    }, 0);
    const totalPurchaseCost = state.data.owned.reduce((sum, item) =>
      sum + item.copies.reduce((copySum, copy) => copySum + Number(copy.paid || 0), 0), 0);
    const unpricedOwnedCopies = visibleOwned.reduce((sum, item) =>
      sum + (cardValue(item.cardId, item.variant) === null ? item.copies.length : 0), 0);
    const visibleWishlist = state.data.wishlist.filter((item) => currentCard(item.cardId));
    const wishlistValue = visibleWishlist.reduce((sum, item) => {
      const value = cardValue(item.cardId, item.variant);
      return sum + (value ?? 0);
    }, 0);
    const unpricedWishlistItems = visibleWishlist.filter((item) => cardValue(item.cardId, item.variant) === null).length;
    const spent = monthlyExpenses();
    $('#owned-count').textContent = String(uniqueOwned);
    $('#owned-count-label').textContent = `${selectedPokemonName()} cards owned`;
    $('#total-count-stat').textContent = `of ${total || '—'}`;
    $('#collection-value').textContent = formatMoney(ownedValue);
    $('#collection-value-note').textContent = `Market estimate · purchase cost ${formatMoney(totalPurchaseCost)}${unpricedOwnedCopies
      ? ` · ${unpricedOwnedCopies} unpriced ${unpricedOwnedCopies === 1 ? 'copy' : 'copies'}`
      : ''}`;
    $('#wishlist-value').textContent = formatMoney(wishlistValue);
    $('#wishlist-count').textContent = `${visibleWishlist.length} ${visibleWishlist.length === 1 ? 'card' : 'cards'}${unpricedWishlistItems ? ` · ${unpricedWishlistItems} unpriced` : ''}`;
    const budget = state.data.monthlyBudget;
    $('#budget-remaining').textContent = formatMoney(budget - spent);
    $('#budget-spent').textContent = `${formatMoney(spent)} spent of ${formatMoney(budget)}`;
    $('#budget-bar').style.width = `${budget > 0 ? Math.min(100, spent / budget * 100) : spent > 0 ? 100 : 0}%`;
    $('#all-tab-count').textContent = total ? String(total) : '—';
    $('#owned-tab-count').textContent = String(allOwnedPrints);
    $('#missing-tab-count').textContent = total ? String(Math.max(0, total - uniqueOwned)) : state.catalogLoaded ? '0' : '—';
    $('#wishlist-tab-count').textContent = String(state.data.wishlist.length);
    $('#nav-owned-count').textContent = String(allOwnedPrints);
    $('#nav-wishlist-count').textContent = String(state.data.wishlist.length);
    const dexNumber = pokedexNumber(state.species.find((species) => species.name === state.selectedPokemon));
    const dexLabel = dexNumber ? `#${dexNumber}` : 'Pokémon';
    $('#focus-pokemon').textContent = selectedPokemonName();
    $('#focus-pokemon-number').textContent = `Pokémon · ${dexLabel}`;
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
      const marketTotal = market === null ? null : market * item.copies.length;
      const purchases = item.copies.map((copy) => [
        copy.addedAt ? new Date(copy.addedAt).toLocaleDateString() : 'Date unavailable',
        copy.acquisitionMethod ? copy.acquisitionMethod.replace('-', ' ') : '',
        copy.seller ? `Seller: ${copy.seller}` : '',
        copy.location ? `Stored: ${copy.location}` : copy.storageLocation ? `Stored: ${copy.storageLocation}` : '',
        copy.binderPage ? `Slot: ${copy.binderPage}` : '',
        copy.gradingStatus === 'graded' ? `${copy.gradingCompany || 'Graded'} ${copy.officialGrade || ''}${copy.certificationNumber ? ` · cert ${copy.certificationNumber}` : ''}` : ''
      ].filter(Boolean).join(' · ')).map((description) => `<div class="owned-purchase-record">${escapeHtml(description)}</div>`).join('');
      return `<div class="owned-entry"><span>${escapeHtml(item.variant)} · ${escapeHtml(item.condition)}${item.language ? ` · ${escapeHtml(item.language)}` : ''}${treatmentVerified ? '' : ' · unverified'}</span><span>${item.copies.length}× · purchase cost ${formatMoney(paid)} · est. market total ${marketTotal === null ? 'unavailable' : formatMoney(marketTotal)}${market !== null && isStale(card) ? ' · stale' : ''}</span>${item.tags?.length ? `<span>Tags: ${escapeHtml(item.tags.join(', '))}</span>` : ''}${purchases}</div>`;
    }).join('');
  }

  function wishlistDetails(card) {
    return state.data.wishlist.map((item, index) => ({ item, index }))
      .filter(({ item }) => item.cardId === card.id).map(({ item, index }) => {
      const key = keyForVariant(item.variant);
      const amount = cardPrice(card, key);
      const treatmentVerified = Object.hasOwn(card.tcgplayer?.prices || {}, key);
      const target = Number.isFinite(item.targetPrice) ? item.targetPrice : null;
      const targetComparison = target === null || amount === null
        ? ''
        : amount <= target
          ? ` · at/below target by ${formatMoney(target - amount)}`
          : ` · ${formatMoney(amount - target)} above target`;
      const targetLabel = target === null ? 'No target' : `Target ${formatMoney(target)}`;
      return `<div class="wish-entry"><span>${escapeHtml(item.variant)} · ${amount === null ? 'market unavailable' : `market est. ${formatMoney(amount)}${isStale(card) ? ' · stale' : ''}`}</span><span>${targetLabel}${targetComparison} · ${escapeHtml(item.priority || 'normal')} priority${treatmentVerified ? '' : ' · unverified treatment'}</span><button class="wish-edit-link" type="button" data-action="wishlist-edit" data-card-id="${escapeAttribute(card.id)}" data-wishlist-index="${index}">Edit target</button></div>`;
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

  function spotlightCard(card, condition, addedAt, action = 'details') {
    const art = card.images?.small || card.images?.large;
    const variant = pricesFor(card)[0] || 'normal';
    const price = cardPrice(card, variant);
    const date = addedAt && Number.isFinite(new Date(addedAt).getTime())
      ? new Date(addedAt).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : '';
    const marketLabel = price === null
      ? 'Unavailable'
      : `${formatMoney(price)}${isStale(card) ? ' · stale' : ''}`;
    return `<button class="spotlight-card recent-card" type="button" data-action="${action}" data-card-id="${escapeAttribute(card.id)}" aria-label="View recently added ${escapeAttribute(card.name)}">
      <span class="recent-card-art">${art ? `<img class="card-art" src="${escapeAttribute(art)}" alt="" loading="lazy">` : '<span class="no-art">Artwork unavailable</span>'}</span>
      <span class="recent-card-info">
        <span class="recent-card-kicker">${date ? `ADDED ${escapeHtml(date)}` : 'RECENTLY ADDED'}</span>
        <strong>${escapeHtml(card.name)}</strong>
        <span class="recent-card-set">${escapeHtml(card.set?.name || 'Set unavailable')}${cardSetNumber(card) ? ` · ${escapeHtml(cardSetNumber(card))}` : ''}</span>
        <span class="recent-card-condition"><span>Condition</span>${escapeHtml(condition || 'Not recorded')}</span>
        <span class="recent-card-market"><span>Market estimate</span><strong>${escapeHtml(marketLabel)}</strong></span>
      </span>
      <span class="recent-card-arrow" aria-hidden="true">↗</span>
    </button>`;
  }

  function featuredFavoriteCard(card) {
    const art = card.images?.small || card.images?.large;
    const variant = primaryVariant(card);
    const price = cardPrice(card, variant);
    const number = cardSetNumber(card);
    const rarity = card.rarity || 'Rarity unavailable';
    const priceLabel = price === null
      ? 'Market unavailable'
      : `${formatMoney(price)}${isStale(card) ? ' · stale' : ''}`;
    return `<button class="spotlight-card favorite-card" type="button" data-action="details" data-card-id="${escapeAttribute(card.id)}" aria-label="View featured favorite ${escapeAttribute(card.name)}">
      <span class="spotlight-art">${art ? `<img class="card-art" src="${escapeAttribute(art)}" alt="" loading="lazy">` : '<span class="no-art">L</span>'}</span>
      <span class="spotlight-info">
        <strong>${escapeHtml(card.name)}</strong>
        <span>${escapeHtml(card.set?.name || 'Set unavailable')}</span>
        <span class="favorite-card-meta">${escapeHtml([number, rarity].filter(Boolean).join(' · '))}</span>
        <span class="spotlight-price">${escapeHtml(priceLabel)}</span>
      </span>
      <span class="favorite-card-star" aria-hidden="true">★</span>
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
      ? recent.map((entry) => spotlightCard(entry.card, entry.condition, entry.date)).join('')
      : '<div class="empty-inline">Add your first card to see it here.</div>';

    const favoriteCards = state.data.favorites.map(currentCard).filter(Boolean).slice(0, 6);
    $('#favorites-count').textContent = `${state.data.favorites.length} SAVED`;
    $('#favorites-grid').innerHTML = favoriteCards.length
      ? favoriteCards.map(featuredFavoriteCard).join('')
      : '<div class="empty-inline">Tap the star on a card to feature it here.</div>';

    const sets = new Map();
    for (const card of state.cards) {
      const setId = card.set?.id || card.set?.name || 'unlisted';
      if (!sets.has(setId)) {
        sets.set(setId, {
          name: card.set?.name || 'Unlisted set',
          logo: card.set?.images?.logo || '',
          total: 0,
          owned: 0
        });
      }
      const row = sets.get(setId);
      row.total += 1;
      if (cardOwned(card.id)) row.owned += 1;
    }
    const setRows = [...sets.values()]
      .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name))
      .slice(0, 8);
    $('#set-progress-list').innerHTML = setRows.length
      ? setRows.map((row) => {
        const percentage = row.total ? Math.round(row.owned / row.total * 100) : 0;
        return `<article class="set-progress-card">
          <div class="set-progress-logo">${row.logo
            ? `<img src="${escapeAttribute(row.logo)}" alt="${escapeAttribute(row.name)} logo" loading="lazy" decoding="async">`
            : '<span class="set-progress-no-logo" aria-hidden="true">SET</span>'}</div>
          <div class="set-progress-label"><strong>${escapeHtml(row.name)}</strong><span>${row.owned} of ${row.total} · ${percentage}%</span></div>
          <div class="set-track" role="progressbar" aria-label="${escapeAttribute(`${row.name} completion`)}" aria-valuemin="0" aria-valuemax="${row.total}" aria-valuenow="${row.owned}"><span style="width:${percentage}%"></span></div>
        </article>`;
      }).join('')
      : '<div class="empty-inline">Set completion appears when the live catalog is available.</div>';
    $('#set-progress-note').textContent = state.catalogLoaded
      ? 'Based on the available catalog for the selected Pokémon; prints not listed by the source are not counted as missing.'
      : state.loading ? 'Loading catalog data; missing counts are not confirmed yet.'
        : 'Catalog unavailable. Set completion and missing counts are not calculated.';

  }

  function populateFilters() {
    const raritySelect = $('#rarity-filter');
    const languageSelect = $('#language-filter');
    const setSelect = $('#set-filter');
    const cards = resultCards();
    const rarities = [...new Set(cards.map((card) => card.rarity).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const languages = [...new Set(cards.map(cardLanguage))].sort((a, b) => a.localeCompare(b));
    const sets = [...new Map(cards.filter((card) => card.set?.id)
      .map((card) => [card.set.id, card.set.name || card.set.id])).entries()]
      .sort((a, b) => a[1].localeCompare(b[1]));
    const pokemonIds = [...new Set(cards.map(cardPokemonId).filter(Boolean))];
    const knownConditions = [...new Set(state.data.owned
      .filter((entry) => cards.some((card) => card.id === entry.cardId))
      .map((entry) => entry.condition).filter(Boolean))].sort((a, b) => a.localeCompare(b));
    const pokemonSelect = $('#card-pokemon-filter');
    const conditionSelect = $('#condition-filter');
    const typeSelect = $('#type-filter');
    const activeValues = {
      pokemon: state.filters.pokemon,
      set: state.filters.set,
      rarity: state.filters.rarity,
      language: state.filters.language,
      condition: state.filters.condition
    };
    const updateOptions = (select, firstOption, options, selected) => {
      select.innerHTML = `<option value="">${firstOption}</option>` +
        options.map(([value, label]) =>
          `<option value="${escapeAttribute(value)}">${escapeHtml(label)}</option>`).join('');
      select.value = options.some(([value]) => value === selected) ? selected : '';
    };
    updateOptions(raritySelect, 'All rarities', rarities.map((value) => [value, value]), activeValues.rarity);
    updateOptions(languageSelect, 'All languages', languages.map((value) => [value, value]), activeValues.language);
    updateOptions(setSelect, 'All sets', sets, activeValues.set);
    updateOptions(pokemonSelect, 'All Pokémon', pokemonIds
      .map((id) => [id, formatPokemonName(id)]).sort((a, b) => a[1].localeCompare(b[1])), activeValues.pokemon);
    updateOptions(conditionSelect, 'Any condition', knownConditions.map((value) => [value, value]), activeValues.condition);
    state.filters.rarity = raritySelect.value;
    state.filters.language = languageSelect.value;
    state.filters.set = setSelect.value;
    state.filters.pokemon = pokemonSelect.value;
    state.filters.condition = conditionSelect.value;
    $('#set-filter-wrap').hidden = sets.length === 0;
    $('#rarity-filter-wrap').hidden = rarities.length === 0;
    $('#language-filter-wrap').hidden = languages.length === 0;
    $('#type-filter-wrap').hidden = !cards.some((card) => isPromotional(card) || isStamped(card));
    $('#card-pokemon-filter-wrap').hidden = pokemonIds.length < 2;
    $('#condition-filter-wrap').hidden = !knownConditions.length;
    const hasPromo = cards.some(isPromotional);
    const hasStamp = cards.some(isStamped);
    typeSelect.innerHTML = '<option value="">All prints</option>' +
      (hasPromo ? '<option value="promo">Promotional</option>' : '') +
      (hasStamp ? '<option value="stamp">Stamped</option>' : '');
    if (!['promo', 'stamp'].includes(state.filters.type) ||
        (state.filters.type === 'promo' && !hasPromo) || (state.filters.type === 'stamp' && !hasStamp)) {
      state.filters.type = '';
    }
    typeSelect.value = state.filters.type;
    $('#ownership-filter').value = state.filters.ownership;
    $('#favorite-filter').value = state.filters.favorites;
    $('#wishlist-filter').value = state.filters.wishlist;
    $('#sort-select').value = state.sort;
  }

  function cardTile(card) {
    const owned = cardOwned(card.id);
    const savedEntry = state.data.owned.find((entry) => entry.cardId === card.id);
    const wished = cardWished(card.id);
    const rarity = card.rarity || 'Rarity not listed';
    const setNumber = cardSetNumber(card);
    const number = setNumber || 'No. unavailable';
    const setName = (state.view === 'owned' && savedEntry?.setName) || card.set?.name || 'Set unavailable';
    const setLogo = card.set?.images?.logo;
    const mainVariant = primaryVariant(card);
    const art = card.images?.large || card.images?.small;
    const verified = !card._savedDetailsOnly && card.name && card.set?.name && card.number;
    const market = cardPrice(card, mainVariant);
    const favorite = isFavorite(card.id);
    const tags = [isPromotional(card) ? 'PROMO' : '', isStamped(card) ? 'STAMPED' : ''].filter(Boolean);
    return `<article class="card-tile ${rarityClass(card)}">
      <button class="card-open" type="button" data-action="details" data-card-id="${escapeHtml(card.id)}" aria-label="View ${escapeHtml(card.name)}, ${escapeHtml(setName)}, number ${escapeHtml(setNumber || 'unknown')} details">
      <span class="card-art-wrap">
        ${owned ? `<span class="tile-mark owned-mark" title="${owned} ${owned === 1 ? 'copy' : 'copies'} in your collection" aria-label="${owned} ${owned === 1 ? 'copy' : 'copies'} in your collection"><span aria-hidden="true">✓</span>${owned > 1 ? `<small>${owned}</small>` : ''}</span>` : ''}
        ${art ? `<img class="card-art" src="${escapeHtml(art)}" alt="${escapeHtml(card.name)} — ${escapeHtml(setName)}" loading="lazy" decoding="async">` : '<span class="no-art" role="img" aria-label="Card artwork unavailable">L</span>'}
      </span>
      <span class="tile-body">
        <span class="tile-set" title="${escapeHtml(setName)}"><span class="tile-set-name">${escapeHtml(setName)}</span>${setLogo ? `<img class="tile-set-logo" src="${escapeAttribute(setLogo)}" alt="${escapeAttribute(setName)} logo" loading="lazy">` : ''}</span>
        <span class="tile-title" title="${escapeHtml((state.view === 'owned' && savedEntry?.cardName) || card.name)}">${escapeHtml((state.view === 'owned' && savedEntry?.cardName) || card.name)}</span>
        <span class="tile-subline"><span>${escapeHtml((state.view === 'owned' && savedEntry?.cardNumber) || number)}</span><span>${escapeHtml((state.view === 'owned' && savedEntry?.rarity) || rarity)}</span><span>${escapeHtml((state.view === 'owned' && savedEntry?.language) || card.lang || '')}</span></span>
        <span class="tile-price-row">${statusForPrice(card, mainVariant)}</span>
        <span class="tile-compare-hint">Compare sources ↗</span>
        ${tags.length ? `<span class="card-tags">${tags.map((tag) => `<span>${tag}</span>`).join('')}</span>` : ''}
      </span>
      </button>
      <div class="tile-body tile-controls">
        <div class="tile-actions">
          ${owned && state.view === 'owned'
            ? `<button class="tile-action secondary missing-action" type="button" data-action="missing" data-card-id="${escapeHtml(card.id)}">Mark missing</button>`
            : `<button class="tile-action" type="button" data-action="owned" data-card-id="${escapeHtml(card.id)}" aria-label="${owned ? `Add another copy of ${escapeHtml(card.name)}` : `Add ${escapeHtml(card.name)} to your collection`}">${owned ? '+ Copy' : '+ Add'}</button>`}
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
    const sourceCards = resultCards();
    state.filterTotal = sourceCards.filter((card) =>
      (state.view !== 'owned' || cardOwned(card.id) > 0) &&
      (state.view !== 'missing' || cardOwned(card.id) === 0) &&
      (state.view !== 'wishlist' || cardWished(card.id))).length;
    let cards = sourceCards.filter((card) => {
      if (state.view === 'owned' && cardOwned(card.id) === 0) return false;
      if (state.view === 'missing' && cardOwned(card.id) > 0) return false;
      if (state.view === 'wishlist' && !cardWished(card.id)) return false;
      if (state.filters.pokemon && cardPokemonId(card) !== state.filters.pokemon) return false;
      if (state.filters.ownership === 'owned' && !cardOwned(card.id)) return false;
      if (state.filters.ownership === 'missing' && cardOwned(card.id)) return false;
      if (state.filters.condition && !state.data.owned.some((entry) =>
        entry.cardId === card.id && entry.condition === state.filters.condition)) return false;
      if (state.filters.favorites && !isFavorite(card.id)) return false;
      if (state.filters.wishlist && !cardWished(card.id)) return false;
      if (state.filters.rarity && card.rarity !== state.filters.rarity) return false;
      if (state.filters.set && card.set?.id !== state.filters.set) return false;
      if (state.filters.language && cardLanguage(card) !== state.filters.language) return false;
      if (state.filters.type === 'promo' && !isPromotional(card)) return false;
      if (state.filters.type === 'stamp' && !isStamped(card)) return false;
      if (query && ![card.name, formatPokemonName(cardPokemonId(card) || ''), card.number, card.rarity, card.set?.name, card.id, card.supertype, ...(card.subtypes || [])]
        .some((value) => String(value || '').toLowerCase().includes(query))) return false;
      return true;
    });
    state.filteredCount = cards.length;
    cards = [...cards];
    cards.sort((a, b) => {
      if (state.sort === 'name') return (a.name || '').localeCompare(b.name || '');
      if (state.sort === 'set') return (a.set?.name || '').localeCompare(b.set?.name || '');
      if (state.sort === 'rarity') return (a.rarity || '').localeCompare(b.rarity || '');
      if (state.sort === 'number') return (a.number || '').localeCompare(b.number || '', undefined, { numeric: true });
      if (state.sort === 'priority' || state.sort === 'target-low') {
        const wishlistValue = (card) => state.data.wishlist.find((item) => item.cardId === card.id);
        const priority = { high: 0, normal: 1, low: 2 };
        const aWishlist = wishlistValue(a);
        const bWishlist = wishlistValue(b);
        if (state.sort === 'priority') {
          return (priority[aWishlist?.priority || 'normal'] ?? 1) -
            (priority[bWishlist?.priority || 'normal'] ?? 1);
        }
        const aTarget = Number.isFinite(aWishlist?.targetPrice) ? aWishlist.targetPrice : Infinity;
        const bTarget = Number.isFinite(bWishlist?.targetPrice) ? bWishlist.targetPrice : Infinity;
        return aTarget - bTarget;
      }
      if (state.sort === 'price-high' || state.sort === 'price-low') {
        const aPrice = cardPrice(a, primaryVariant(a));
        const bPrice = cardPrice(b, primaryVariant(b));
        if (aPrice === null || bPrice === null) {
          if (aPrice === null && bPrice === null) return 0;
          return aPrice === null ? 1 : -1;
        }
        return state.sort === 'price-high' ? bPrice - aPrice : aPrice - bPrice;
      }
      const latestAdded = (card) => Math.max(-1, ...state.data.owned.filter((item) => item.cardId === card.id)
        .flatMap((item) => item.copies.map((copy) => new Date(copy.addedAt || 0).getTime())));
      if (state.sort === 'date-added') return latestAdded(b) - latestAdded(a);
      return (b.set?.releaseDate || '').localeCompare(a.set?.releaseDate || '');
    });
    return cards;
  }

  function activeFiltersExist() {
    return Boolean(state.query.trim() || Object.values(state.filters).some(Boolean));
  }

  function clearFilters() {
    state.query = '';
    state.filters = { rarity: '', language: '', type: '', set: '', pokemon: '', ownership: '', condition: '', favorites: '', wishlist: '' };
    $('#search-input').value = '';
    $('#collection-search').value = '';
    $('#sort-select').value = 'date-added';
    state.sort = 'date-added';
    renderCatalog();
  }

  function renderCatalog() {
    populateFilters();
    const catalogGrid = $('#catalog-grid');
    catalogGrid.classList.toggle('wishlist-grid', state.view === 'wishlist');
    const cards = visibleCards();
    const viewCards = state.view === 'wishlist' ? state.wishlistCards
      : state.view === 'owned' ? state.ownedCards : state.cards;
    const viewLoading = state.view === 'wishlist' ? state.wishlistLoading
      : state.view === 'owned' ? state.ownedLoading : state.loading;
    const unavailableWishlist = state.view === 'wishlist'
      ? state.wishlistUnavailableIds
        .map((id) => ({
          id,
          variants: [...new Set(state.data.wishlist.filter((item) => item.cardId === id).map((item) => item.variant))]
        }))
        .filter((item) => !state.query || [item.id, ...item.variants]
          .some((value) => value.toLowerCase().includes(state.query.trim().toLowerCase())))
      : [];
    const unavailableOwned = state.view === 'owned'
      ? state.ownedUnavailableIds
        .map((id) => ({
          id,
          name: state.data.owned.find((item) => item.cardId === id)?.cardName || id
        }))
        .filter((item) => !state.query || [item.id, item.name]
          .some((value) => value.toLowerCase().includes(state.query.trim().toLowerCase())))
      : [];
    catalogGrid.innerHTML = viewLoading && !cards.length
      ? Array.from({ length: 6 }, () => '<div class="skeleton-card" aria-hidden="true"><div class="skeleton-art"></div><div class="skeleton-line"></div><div class="skeleton-line short"></div></div>').join('')
      : cards.map(cardTile).join('');
    catalogGrid.hidden = !cards.length && !(viewLoading && !viewCards.length);
    const unavailableElement = $('#wishlist-unavailable');
    unavailableElement.hidden = unavailableWishlist.length === 0 && unavailableOwned.length === 0;
    unavailableElement.innerHTML = unavailableOwned.length
      ? `<strong>Some owned card details could not be loaded</strong><p>Your saved cards are still listed below, using the details saved with each collection entry.</p>${unavailableOwned.map((item) =>
        `<div class="wishlist-unavailable-item"><span>${escapeHtml(item.name)}</span><span>${escapeHtml(item.id)}</span></div>`
      ).join('')}`
      : unavailableWishlist.length
        ? `<strong>Saved, but card details are unavailable</strong><p>These wishlist entries remain on this device. Reconnect and sync to load their official card details.</p>${unavailableWishlist.map((item) =>
          `<div class="wishlist-unavailable-item"><span>${escapeHtml(item.id)}</span><span>${escapeHtml(item.variants.join(', '))}</span></div>`
        ).join('')}`
        : '';
    $('#filter-match-count').textContent = activeFiltersExist()
      ? `${cards.length} matching ${cards.length === 1 ? 'card' : 'cards'} · ${state.filterTotal} in view`
      : `Showing ${state.filterTotal} ${state.filterTotal === 1 ? 'card' : 'cards'}`;
    $('#clear-filters-button').disabled = !activeFiltersExist();
    $('#empty-state').hidden = cards.length !== 0 || unavailableWishlist.length !== 0 ||
      unavailableOwned.length !== 0 || (viewLoading && !viewCards.length);
    $('#result-count').textContent = state.view === 'wishlist'
      ? state.wishlistLoading
        ? `${cards.length} of ${new Set(state.data.wishlist.map((item) => item.cardId)).size} saved wishlist cards loaded…`
        : unavailableWishlist.length
          ? `${cards.length} of ${new Set(state.data.wishlist.map((item) => item.cardId)).size} wishlist cards loaded · ${unavailableWishlist.length} unavailable`
          : `${cards.length} ${cards.length === 1 ? 'card' : 'cards'} on your wishlist`
      : state.view === 'owned'
        ? state.ownedLoading
          ? `${cards.length} of ${new Set(state.data.owned.map((item) => item.cardId)).size} owned prints loading…`
          : `${cards.length} owned ${cards.length === 1 ? 'print' : 'prints'} across your collection`
        : state.cards.length
        ? `${cards.length} ${cards.length === 1 ? 'print' : 'prints'} for ${selectedPokemonName()}${state.view === 'all' ? '' : ` · ${state.view}`}`
        : 'No catalog records available';
    if (!cards.length) {
      if (state.view === 'wishlist') {
        $('#empty-title').textContent = state.wishlistLoading
          ? 'Loading your wishlist'
          : state.data.wishlist.length && state.query ? 'No matching wishlist cards' : 'Your wishlist is empty';
        $('#empty-copy').textContent = state.wishlistLoading
          ? 'Loading your saved cards across Pokémon…'
          : state.data.wishlist.length && state.query
            ? 'Try a different search to find a saved card.'
            : 'Add cards from any Pokémon to see them all here.';
        $('#empty-action').textContent = 'Browse cards';
      } else if (state.view === 'owned') {
        $('#empty-title').textContent = state.ownedLoading ? 'Loading your collection' : 'Your collection is waiting';
        $('#empty-copy').textContent = state.ownedLoading
          ? 'Loading saved card details across your Pokémon…'
          : 'Add cards from any Pokémon and they will all appear in this tab.';
        $('#empty-action').textContent = 'Browse catalog';
      } else if (!state.cards.length) {
        $('#empty-title').textContent = state.loading
          ? `Loading ${selectedPokemonName()} cards`
          : state.catalogLoaded ? `No cards found for ${selectedPokemonName()}` : 'Catalog unavailable';
        $('#empty-copy').textContent = state.loading
          ? 'Connecting to the live Pokémon TCG catalog…'
          : state.catalogLoaded
            ? 'No Pokémon TCG cards are currently listed for this Pokémon. Choose another Pokémon or try again later.'
            : 'Check your connection and refresh. Your saved collection remains on this device.';
        $('#empty-action').textContent = 'Refresh catalog';
      } else {
        $('#empty-title').textContent = state.view === 'owned' ? 'Your collection is waiting' : state.view === 'missing' ? 'Every print is accounted for' : state.view === 'wishlist' ? 'Your wishlist is empty' : 'No matching cards';
        $('#empty-copy').textContent = state.view === 'all'
          ? 'Try a different search, or refresh the live card catalog.'
          : state.view === 'missing' ? 'You have marked every catalog print as owned.'
            : `Browse ${selectedPokemonName()} prints to find a card to add here.`;
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
    if (view === 'wishlist') loadWishlistCards();
    if (view === 'owned') loadOwnedCards(true);
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

  function setCatalogIndicator(label, status) {
    $('#catalog-live-label').textContent = label;
    $('#catalog-live-indicator').classList.remove('is-updating', 'is-cached', 'is-unavailable');
    if (status) $('#catalog-live-indicator').classList.add(`is-${status}`);
  }

  function cacheCards(cards) {
    const key = `${CATALOG_CACHE_PREFIX}${encodeURIComponent(state.selectedPokemon)}`;
    const record = JSON.stringify({
      savedAt: new Date().toISOString(),
      pokemon: state.selectedPokemon,
      cards
    });
    let index = [];
    try {
      const cachedIndex = JSON.parse(localStorage.getItem(CATALOG_CACHE_INDEX_KEY) || '[]');
      if (Array.isArray(cachedIndex)) index = cachedIndex.filter((item) => typeof item === 'string');
    } catch (error) {
      console.warn('Could not read cached catalog index:', error);
    }
    index = [key, ...index.filter((item) => item !== key)];
    try {
      localStorage.setItem(key, record);
      for (const oldKey of index.slice(MAX_CACHED_CATALOGS)) localStorage.removeItem(oldKey);
      localStorage.setItem(CATALOG_CACHE_INDEX_KEY, JSON.stringify(index.slice(0, MAX_CACHED_CATALOGS)));
      localStorage.setItem(CACHE_KEY, record);
    } catch (error) {
      console.warn('Could not cache card catalog; removing older catalog caches and retrying:', error);
      try {
        for (const oldKey of index.slice(1)) localStorage.removeItem(oldKey);
        localStorage.setItem(key, record);
        localStorage.setItem(CATALOG_CACHE_INDEX_KEY, JSON.stringify([key]));
        localStorage.setItem(CACHE_KEY, record);
      } catch (retryError) {
        console.error('Could not save the card catalog to device storage:', retryError);
      }
    }
  }

  function readCatalogCache(pokemon) {
    const key = `${CATALOG_CACHE_PREFIX}${encodeURIComponent(pokemon)}`;
    try {
      let cached = JSON.parse(localStorage.getItem(key) || 'null');
      if (!cached) {
        const index = JSON.parse(localStorage.getItem(CATALOG_CACHE_INDEX_KEY) || '[]');
        if (Array.isArray(index)) {
          for (const indexedKey of index) {
            if (typeof indexedKey !== 'string') continue;
            const entry = JSON.parse(localStorage.getItem(indexedKey) || 'null');
            if (entry?.pokemon === pokemon) {
              cached = entry;
              break;
            }
          }
        }
      }
      if (!cached) {
        const legacy = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
        if (legacy?.pokemon === pokemon) cached = legacy;
      }
      if (cached && cached.pokemon === pokemon && Array.isArray(cached.cards)) return cached;
    } catch (error) {
      console.warn(`Could not read the cached ${formatPokemonName(pokemon)} catalog:`, error);
    }
    return null;
  }

  function fetchDelay(response, attempt) {
    const retryAfter = response?.headers.get('Retry-After');
    if (retryAfter) {
      const seconds = Number(retryAfter);
      const dateDelay = Date.parse(retryAfter) - Date.now();
      const delay = Number.isFinite(seconds) ? seconds * 1000 : dateDelay;
      if (Number.isFinite(delay) && delay > 0) return Math.min(delay, 10000);
    }
    return Math.min(600 * (2 ** (attempt - 1)), 5000);
  }

  function cachedCardsById() {
    const cardsById = new Map([...state.cards, ...state.ownedCards, ...state.wishlistCards]
      .filter((card) => !card._savedDetailsOnly)
      .map((card) => [card.id, card]));
    const keys = [];
    try {
      for (let index = 0; index < localStorage.length; index += 1) {
        const key = localStorage.key(index);
        if (key === CACHE_KEY || key === WISHLIST_CARD_CACHE_KEY || key?.startsWith(CATALOG_CACHE_PREFIX)) keys.push(key);
      }
      for (const key of keys) {
        const cached = JSON.parse(localStorage.getItem(key) || 'null');
        const cards = Array.isArray(cached) ? cached : cached?.cards;
        if (!Array.isArray(cards)) continue;
        for (const card of cards) {
          if (typeof card?.id === 'string' && !cardsById.has(card.id)) cardsById.set(card.id, card);
        }
      }
    } catch (error) {
      console.warn('Could not read saved card catalogs for wishlist:', error);
    }
    return cardsById;
  }

  async function loadOwnedCards(fetchMissing = state.view === 'owned') {
    if (state.ownedLoadPromise) {
      state.ownedReloadRequested = true;
      return state.ownedLoadPromise;
    }
    const ownedIds = [...new Set(state.data.owned.map((item) => item.cardId))];
    const knownCards = cachedCardsById();
    state.ownedCards = ownedIds.map((id) => knownCards.get(id) || ownedFallbackCard(id)).filter(Boolean);
    const missingIds = ownedIds.filter((id) => !knownCards.has(id));
    state.ownedUnavailableIds = [];
    state.ownedLoading = fetchMissing && missingIds.length > 0;
    renderCatalog();
    if (!fetchMissing || !missingIds.length) return;

    state.ownedLoadPromise = (async () => {
      const unavailable = [];
      for (let index = 0; index < missingIds.length; index += CATALOG_RETRY_LIMIT) {
        const batch = missingIds.slice(index, index + CATALOG_RETRY_LIMIT);
        const results = await Promise.all(batch.map(async (id) => {
          const escapedId = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const url = new URL(API);
          url.searchParams.set('q', `id:"${escapedId}"`);
          url.searchParams.set('pageSize', '1');
          try {
            const payload = await fetchCatalogPage(url);
            const card = payload.data.find((item) => item.id === id) || null;
            if (!card) unavailable.push(id);
            return card;
          } catch (error) {
            console.warn(`Could not load owned card ${id}:`, error);
            unavailable.push(id);
            return null;
          }
        }));
        for (const card of results.filter(Boolean)) knownCards.set(card.id, card);
        const currentIds = [...new Set(state.data.owned.map((item) => item.cardId))];
        state.ownedCards = currentIds.map((id) => knownCards.get(id) || ownedFallbackCard(id)).filter(Boolean);
        renderCatalog();
      }
      state.ownedUnavailableIds = [...new Set(unavailable.filter((id) =>
        state.data.owned.some((item) => item.cardId === id)))];
    })().finally(() => {
      state.ownedLoading = false;
      state.ownedLoadPromise = null;
      renderCatalog();
      if (state.ownedReloadRequested) {
        state.ownedReloadRequested = false;
        loadOwnedCards();
      }
    });
    return state.ownedLoadPromise;
  }

  function cacheWishlistCards(cards) {
    if (!cards.length) return;
    try {
      const cached = JSON.parse(localStorage.getItem(WISHLIST_CARD_CACHE_KEY) || '[]');
      const savedCards = new Map(
        (Array.isArray(cached) ? cached : [])
          .filter((card) => typeof card?.id === 'string')
          .map((card) => [card.id, card])
      );
      for (const card of cards) savedCards.set(card.id, card);
      localStorage.setItem(WISHLIST_CARD_CACHE_KEY, JSON.stringify([...savedCards.values()]));
    } catch (error) {
      console.warn('Could not cache resolved wishlist card details:', error);
    }
  }

  async function loadWishlistCards() {
    if (state.wishlistLoadPromise) {
      state.wishlistReloadRequested = true;
      return state.wishlistLoadPromise;
    }
    const wishlistIds = [...new Set(state.data.wishlist.map((item) => item.cardId))];
    const cachedCards = cachedCardsById();
    state.wishlistCards = wishlistIds.map((id) => cachedCards.get(id)).filter(Boolean);
    cacheWishlistCards(state.wishlistCards);
    const missingIds = wishlistIds.filter((id) => !cachedCards.has(id));
    state.wishlistLoading = missingIds.length > 0;
    state.wishlistUnavailableIds = [];
    renderCatalog();
    if (!missingIds.length) return;

    state.wishlistLoadPromise = (async () => {
      const unavailable = [];
      for (let index = 0; index < missingIds.length; index += CATALOG_RETRY_LIMIT) {
        const batch = missingIds.slice(index, index + CATALOG_RETRY_LIMIT);
        const results = await Promise.all(batch.map(async (id) => {
          const escapedId = id.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
          const url = new URL(API);
          url.searchParams.set('q', `id:"${escapedId}"`);
          url.searchParams.set('pageSize', '1');
          try {
            const payload = await fetchCatalogPage(url);
            const card = payload.data.find((item) => item.id === id) || null;
            if (!card) unavailable.push(id);
            return card;
          } catch (error) {
            console.warn(`Could not load wishlist card ${id}:`, error);
            unavailable.push(id);
            return null;
          }
        }));
        const loadedCards = results.filter(Boolean);
        state.wishlistCards.push(...loadedCards);
        cacheWishlistCards(loadedCards);
        renderCatalog();
      }
      state.wishlistUnavailableIds = [...new Set(unavailable.filter((id) =>
        state.data.wishlist.some((item) => item.cardId === id)))];
      if (state.wishlistUnavailableIds.length) {
        const count = state.wishlistUnavailableIds.length;
        showToast(`${count} wishlist ${count === 1 ? 'card could' : 'cards could'} not be loaded. They remain saved; try again when online.`);
      }
    })().finally(() => {
      state.wishlistLoading = false;
      state.wishlistLoadPromise = null;
      renderCatalog();
      if (state.wishlistReloadRequested) {
        state.wishlistReloadRequested = false;
        loadWishlistCards();
      }
    });
    return state.wishlistLoadPromise;
  }

  function wait(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }

  async function fetchCatalogPage(url) {
    let lastError;
    for (let attempt = 1; attempt <= CATALOG_RETRY_LIMIT; attempt += 1) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), CATALOG_TIMEOUT_MS);
      let response;
      try {
        response = await fetch(url, {
          headers: { Accept: 'application/json' },
          signal: controller.signal
        });
        if (response.ok) {
          const payload = await response.json();
          if (!Array.isArray(payload.data)) throw new Error('Card API returned an unexpected response.');
          return payload;
        }
        lastError = new Error(`Card API returned HTTP ${response.status}`);
        const retryable = response.status === 429 || [500, 502, 503, 504].includes(response.status);
        if (!retryable || attempt === CATALOG_RETRY_LIMIT) throw lastError;
      } catch (error) {
        lastError = error.name === 'AbortError'
          ? new Error(`Card API request timed out after ${CATALOG_TIMEOUT_MS / 1000} seconds.`)
          : error;
        const retryable = error.name === 'AbortError' || error instanceof TypeError ||
          /^Card API returned HTTP (429|500|502|503|504)$/.test(error.message);
        if (!retryable || attempt === CATALOG_RETRY_LIMIT) throw lastError;
      } finally {
        clearTimeout(timeout);
      }
      console.warn(`Card catalog request failed (attempt ${attempt}/${CATALOG_RETRY_LIMIT}); retrying.`);
      await wait(fetchDelay(response, attempt));
    }
    throw lastError || new Error('Card catalog request failed.');
  }

  async function loadPokemonSpecies() {
    let cachedSpecies = [];
    try {
      const cached = JSON.parse(localStorage.getItem(SPECIES_CACHE_KEY) || 'null');
      if (Array.isArray(cached)) {
        cachedSpecies = cached.filter((species) =>
          species && typeof species.name === 'string' && typeof species.url === 'string');
      }
    } catch (error) {
      console.warn('Could not read cached Pokémon list:', error);
    }

    try {
      const response = await fetch(POKEDEX_API, { headers: { Accept: 'application/json' } });
      if (!response.ok) throw new Error(`National Pokédex returned HTTP ${response.status}`);
      const payload = await response.json();
      const results = Array.isArray(payload.pokemon_entries) ? payload.pokemon_entries
        .filter((entry) => Number.isInteger(entry?.entry_number) && entry.entry_number > 0 &&
          typeof entry.pokemon_species?.name === 'string' && typeof entry.pokemon_species?.url === 'string')
        .map((entry) => ({
          name: entry.pokemon_species.name,
          url: entry.pokemon_species.url,
          number: entry.entry_number
        })) : [];
      if (!results.length) {
        throw new Error('Pokémon list returned an unexpected response.');
      }
      state.species = results;
      try {
        localStorage.setItem(SPECIES_CACHE_KEY, JSON.stringify(state.species));
      } catch (error) {
        console.warn('Could not cache Pokémon list:', error);
      }
    } catch (error) {
      console.error('Could not load the full Pokémon list:', error);
      state.species = cachedSpecies;
      if (!state.species.length) {
        state.species = [{ name: 'lucario', url: 'https://pokeapi.co/api/v2/pokemon-species/448/' }];
        showToast('The National Pokédex could not be loaded. Check your connection and refresh to try again.');
      }
    }

    state.speciesByName = [...state.species].sort((a, b) => b.name.length - a.name.length);
    const selector = $('#pokemon-filter');
    selector.innerHTML = [...state.species]
      .sort((a, b) => (pokedexNumber(a) ?? Number.MAX_SAFE_INTEGER) - (pokedexNumber(b) ?? Number.MAX_SAFE_INTEGER))
      .map((species) => {
        const number = pokedexNumber(species);
        const label = number
          ? `#${number} ${formatPokemonName(species.name)}`
          : formatPokemonName(species.name);
        return `<option value="${escapeAttribute(species.name)}">${escapeHtml(label)}</option>`;
      }).join('');
    if (!state.species.some((species) => species.name === state.selectedPokemon)) state.selectedPokemon = 'lucario';
    selector.value = state.selectedPokemon;
  }

  function restoreCatalogCache() {
    try {
      let cached = JSON.parse(localStorage.getItem(CACHE_KEY) || 'null');
      if (!cached) {
        const index = JSON.parse(localStorage.getItem(CATALOG_CACHE_INDEX_KEY) || '[]');
        if (Array.isArray(index)) {
          for (const key of index) {
            if (typeof key !== 'string') continue;
            const entry = JSON.parse(localStorage.getItem(key) || 'null');
            if (entry && Array.isArray(entry.cards)) {
              cached = entry;
              break;
            }
          }
        }
      }
      if (cached && Array.isArray(cached.cards)) {
        state.cards = cached.cards;
        state.selectedPokemon = typeof cached.pokemon === 'string' ? cached.pokemon : 'lucario';
        state.catalogLoaded = true;
        renderCatalog();
        const date = cached.savedAt ? new Date(cached.savedAt).toLocaleDateString() : 'an earlier session';
        $('#sync-status').textContent = `Offline · ${formatPokemonName(state.selectedPokemon)} catalog cached ${date}`;
        setCatalogIndicator('SAVED OFFLINE', 'cached');
      }
    } catch (error) {
      console.warn('Could not read cached card catalog:', error);
    }
  }

  async function loadCatalog() {
    if (state.loading) return;
    const pokemonId = $('#pokemon-filter').value || state.selectedPokemon;
    const speciesName = pokemonSearchTerm(pokemonId);
    const escapedName = speciesName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const pokemon = formatPokemonName(pokemonId);
    const changingPokemon = pokemonId !== state.selectedPokemon;
    state.selectedPokemon = pokemonId;
    if (changingPokemon) {
      state.filters.rarity = '';
      state.filters.language = '';
      state.filters.set = '';
      state.filters.type = '';
      state.filters.pokemon = '';
      state.filters.condition = '';
    }
    const cached = readCatalogCache(pokemonId);
    if (changingPokemon || (!state.cards.length && cached)) {
      state.cards = cached ? cached.cards : [];
      state.catalogLoaded = Boolean(cached);
    }
    state.loading = true;
    $('#refresh-button').disabled = true;
    $('#refresh-button').setAttribute('aria-busy', 'true');
    $('#pokemon-filter').disabled = true;
    $('#sidebar-sync-dot').classList.remove('live');
    $('#refresh-button').lastChild.textContent = cached ? ' Updating…' : ' Syncing…';
    $('#sync-status').textContent = cached
      ? `Refreshing · showing saved ${pokemon} catalog`
      : `Loading ${pokemon} cards…`;
    setCatalogIndicator(cached ? 'UPDATING' : 'CONNECTING', 'updating');
    $('#result-count').textContent = cached
      ? `Showing saved ${pokemon} cards while the live catalog refreshes…`
      : `Connecting to the ${pokemon} card catalog…`;
    renderCatalog();
    try {
      const cards = [];
      let page = 1;
      let totalCount = Infinity;
      while (cards.length < totalCount) {
        const url = new URL(API);
        url.searchParams.set('q', `name:"${escapedName}"`);
        url.searchParams.set('pageSize', '250');
        url.searchParams.set('page', String(page));
        url.searchParams.set('orderBy', '-set.releaseDate');
        const payload = await fetchCatalogPage(url);
        totalCount = Number.isFinite(payload.totalCount) ? payload.totalCount : payload.data.length;
        cards.push(...payload.data);
        if (payload.data.length === 0 || payload.data.length < 250) break;
        page += 1;
      }
      state.cards = cards;
      state.catalogLoaded = true;
      cacheCards(cards);
      state.lastCatalogSuccessAt = Date.now();
      $('#sync-status').textContent = cards.length
        ? `Live · ${cards.length} ${pokemon} prints from Pokémon TCG API`
        : `Live · no Pokémon TCG cards listed for ${pokemon}`;
      $('#sidebar-sync-dot').classList.add('live');
      setCatalogIndicator('LIVE', '');
      renderCatalog();
    } catch (error) {
      console.error('Live card catalog could not be loaded:', error);
      $('#sync-status').textContent = cached
        ? `Offline · ${pokemon} catalog saved ${cached.savedAt ? new Date(cached.savedAt).toLocaleDateString() : 'earlier'}`
        : state.cards.length
        ? 'Offline · showing the last cached catalog'
        : 'Card catalog unavailable · check your connection and try again';
      $('#sidebar-sync-dot').classList.remove('live');
      setCatalogIndicator(cached ? 'SAVED OFFLINE' : 'UNAVAILABLE', cached ? 'cached' : 'unavailable');
      if (!state.cards.length) {
        $('#result-count').textContent = 'Could not connect to the live card catalog.';
        $('#empty-title').textContent = 'Catalog unavailable';
        $('#empty-copy').textContent = `Your saved collection is safe on this device. Check your connection and refresh to load ${pokemon} cards.`;
        $('#empty-action').textContent = 'Try again';
      }
      showToast(state.cards.length
        ? `${pokemon} catalog refresh failed; saved cards are still available.`
        : 'Could not load the live catalog. Use Sync catalog to retry.');
    } finally {
      state.loading = false;
      $('#refresh-button').disabled = false;
      $('#refresh-button').removeAttribute('aria-busy');
      $('#refresh-button').lastChild.textContent = ' Sync catalog';
      $('#pokemon-filter').disabled = false;
      renderCatalog();
    }
  }

  async function loadOcrLibrary() {
    if (window.Tesseract) return window.Tesseract;
    await new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load the on-device text recognition library.'));
      document.head.append(script);
    });
    if (!window.Tesseract) throw new Error('The text recognition library did not initialize.');
    return window.Tesseract;
  }

  function stopScannerCamera() {
    if (state.scanWorker) {
      state.scanWorker.terminate().catch((error) => console.warn('Could not stop text recognition worker cleanly:', error));
      state.scanWorker = null;
    }
    state.scanRunning = false;
    if (state.cameraStream) {
      state.cameraStream.getTracks().forEach((track) => track.stop());
      state.cameraStream = null;
    }
    $('#scanner-video').srcObject = null;
    $('#scanner-capture').disabled = true;
    $('#scanner-torch').disabled = true;
    state.scanTorchEnabled = false;
    $('#scanner-torch').setAttribute('aria-pressed', 'false');
    $('#scanner-torch').textContent = 'Flashlight';
  }

  async function openScanner() {
    state.scanRescanQueueId = '';
    $('#scanner-camera-wrap').hidden = false;
    $('#scanner-video').hidden = false;
    $('#scanner-image-editor').hidden = true;
    $('#scanner-results').replaceChildren();
    $('#scanner-upload').value = '';
    $('#scanner-crop').value = '0';
    $('#scanner-crop-value').value = '0%';
    renderScanQueue();
    $('#scanner-capture').disabled = true;
    $('#scanner-dialog').showModal();
    if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
      $('#scanner-camera-wrap').hidden = true;
      $('#scanner-status').textContent = !window.isSecureContext
        ? 'Camera access requires HTTPS or localhost in a supported browser. Upload a card image or search manually instead.'
        : 'This browser does not support camera capture. Upload a card image or search manually instead.';
      return;
    }
    $('#scanner-status').textContent = 'Requesting the rear-facing camera…';
    try {
      state.cameraStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }
      });
      if (!$('#scanner-dialog').open) {
        stopScannerCamera();
        return;
      }
      const video = $('#scanner-video');
      video.srcObject = state.cameraStream;
      await video.play();
      const track = state.cameraStream.getVideoTracks()[0];
      const capabilities = track?.getCapabilities?.();
      $('#scanner-torch').disabled = !capabilities || !('torch' in capabilities);
      $('#scanner-status').textContent = 'Hold one card upright inside the guides. Avoid glare and keep the number sharp.';
      $('#scanner-capture').disabled = false;
    } catch (error) {
      console.error('Could not start card scanner camera:', error);
      stopScannerCamera();
      $('#scanner-camera-wrap').hidden = true;
      $('#scanner-status').textContent = error.name === 'NotAllowedError' || error.name === 'PermissionDeniedError'
        ? 'Camera permission was denied. Allow access in browser settings, or upload a card image instead.'
        : error.name === 'NotFoundError' || error.name === 'DevicesNotFoundError'
          ? 'No camera was found. Connect a camera or upload a card image instead.'
          : error.name === 'NotReadableError' || error.name === 'TrackStartError'
            ? 'The camera is busy or unavailable. Close other camera apps or upload an image instead.'
            : 'Could not start the camera. Check browser permissions and try uploading a card image.';
    }
  }

  function normalizeScanText(value) {
    return String(value || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '')
      .toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  function findScannedPokemon(text) {
    const speciesByName = [...state.species]
      .sort((a, b) => normalizeScanText(b.name).length - normalizeScanText(a.name).length);
    for (const line of text.split(/\r?\n/)) {
      const normalizedLine = normalizeScanText(line);
      const match = speciesByName.find((species) => {
        const name = normalizeScanText(species.name);
        return name.length > 2 && normalizedLine.includes(name);
      });
      if (match) return match;
    }
    return null;
  }

  function scanNumberFromText(text) {
    const match = String(text || '').match(/\b(?:no\.?\s*)?(\d{1,4})\s*[\/|]\s*(\d{1,4})\b/i);
    return match ? { number: match[1].replace(/^0+(?=\d)/, ''), total: match[2] } : null;
  }

  function scoreScanCandidate(card, text, number, species, manual = false) {
    const normalizedText = normalizeScanText(text);
    const normalizedName = normalizeScanText(card.name);
    const exactName = normalizedName.length > 2 && normalizedText.includes(normalizedName);
    const cardNumberMatch = Boolean(number && String(Number(card.number)) === String(Number(number.number)));
    const totalMatch = Boolean(number && (!number.total ||
      (Number.isInteger(card.set?.printedTotal) && card.set.printedTotal > 0 &&
        String(card.set.printedTotal) === String(Number(number.total)))));
    const numberMatch = cardNumberMatch && totalMatch;
    const pokemonName = species ? normalizeScanText(species.name) : '';
    const pokemonMatch = Boolean(pokemonName && normalizedName.includes(pokemonName));
    const reason = manual
      ? 'Manual catalog search result · verify the exact print'
      : exactName && numberMatch
        ? 'Card name and collector number appear in OCR · verify the artwork'
        : numberMatch
          ? 'Collector number matches OCR · card name and artwork still need confirmation'
          : cardNumberMatch && number?.total &&
            (!Number.isInteger(card.set?.printedTotal) || card.set.printedTotal <= 0)
            ? 'Card number matches OCR; catalog set total unavailable · verify the exact print'
          : exactName
            ? 'Card name appears in OCR · verify set and collector number'
            : cardNumberMatch && number?.total
              ? 'Card number matches but printed set total differs · verify the exact print'
            : pokemonMatch
              ? `Possible ${formatPokemonName(species.name)} card · exact print not identified`
              : 'Possible text match · verify card, set, and number';
    return { card, exactName, numberMatch, cardNumberMatch, totalMatch, pokemonMatch, reason };
  }

  function renderScanResults(candidates, heading = 'Possible catalog matches') {
    const results = $('#scanner-results');
    if (!candidates.length) {
      results.innerHTML = '<p class="scanner-no-results">Card not confidently identified. Search the catalog manually, upload a clearer image, or retake the photo. No card has been selected.</p>';
      return;
    }
    results.innerHTML = `<h3>${escapeHtml(heading)}</h3><p class="scanner-intro">Select a candidate only after checking its artwork and printed details.</p>` +
      candidates.slice(0, 3).map(({ card, reason }) => {
        const art = card.images?.large || card.images?.small;
        return `<button class="scanner-result" type="button" data-scan-card-id="${escapeAttribute(card.id)}">
          ${art ? `<img src="${escapeAttribute(art)}" alt="" loading="lazy">` : '<span class="scanner-result-no-art">?</span>'}
          <span><strong>${escapeHtml(card.name || 'Unknown card')}</strong><span>${escapeHtml(card.set?.name || 'Set unavailable')} · ${escapeHtml(cardSetNumber(card) || 'Number unavailable')}</span><span>${escapeHtml(cardLanguage(card))} · ${escapeHtml(card.rarity || 'Rarity unavailable')}</span><small>${escapeHtml(reason)}</small></span>
          <span class="scanner-result-arrow">Add to queue ›</span>
        </button>`;
      }).join('');
  }

  async function queryScanCatalog(query, text = '', species = null, number = null, manual = false) {
    const trimmed = query.trim();
    if (!trimmed) {
      $('#scanner-status').textContent = 'Enter a Pokémon or card name to search the catalog.';
      return;
    }
    $('#scanner-search-button').disabled = true;
    $('#scanner-status').textContent = 'Searching the Pokémon TCG catalog…';
    $('#scanner-results').replaceChildren();
    try {
      const fetchCandidates = async (fieldQuery) => {
        const url = new URL(API);
        url.searchParams.set('q', fieldQuery);
        url.searchParams.set('pageSize', '100');
        url.searchParams.set('orderBy', '-set.releaseDate');
        const payload = await fetchCatalogPage(url);
        if (!Array.isArray(payload.data)) throw new Error('Card API returned an unexpected response.');
        return payload.data;
      };
      const safeQuery = trimmed.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
      const queries = [fetchCandidates(`name:"${safeQuery}"`)];
      if (!manual && number) queries.push(fetchCandidates(`number:"${number.number}"`));
      const responses = await Promise.allSettled(queries);
      const cardsById = new Map();
      for (const response of responses) {
        if (response.status === 'fulfilled') {
          for (const card of response.value) cardsById.set(card.id, card);
        }
      }
      if (!cardsById.size) {
        const failure = responses.find((response) => response.status === 'rejected');
        if (!responses.some((response) => response.status === 'fulfilled')) {
          throw failure?.reason || new Error('The catalog request did not complete.');
        }
        state.scannedCards = [];
        $('#scanner-status').textContent = `Card not confidently identified${failure ? ' (some catalog searches were unavailable)' : ''}. Try another search or image; no card has been selected.`;
        renderScanResults([]);
        return;
      }
      const cards = [...cardsById.values()];
      state.scannedCards = cards;
      const candidates = cards.map((card) =>
        scoreScanCandidate(card, text, number, species, manual))
        .sort((a, b) => Number(b.exactName && b.numberMatch) - Number(a.exactName && a.numberMatch) ||
          Number(b.numberMatch) - Number(a.numberMatch) ||
          Number(b.exactName) - Number(a.exactName) ||
          Number(b.cardNumberMatch) - Number(a.cardNumberMatch) ||
          Number(b.pokemonMatch) - Number(a.pokemonMatch));
      $('#scanner-status').textContent = candidates.length
        ? `Showing up to ${Math.min(candidates.length, 3)} of ${candidates.length} catalog candidates${responses.some((response) => response.status === 'rejected') ? ' (some search terms were unavailable)' : ''}. None has been selected.`
        : 'Card not confidently identified. Try a manual catalog search or a clearer image.';
      renderScanResults(candidates, manual ? 'Catalog search results' : 'Possible catalog matches');
    } catch (error) {
      console.error('Could not search catalog for scanned card:', error);
      $('#scanner-status').textContent = 'Catalog search failed. Your image remains available; check the connection or search again.';
      $('#scanner-results').innerHTML = `<p class="scanner-no-results">${escapeHtml(error.message || 'An unexpected catalog error occurred.')}</p>`;
    } finally {
      $('#scanner-search-button').disabled = false;
    }
  }

  function updateScanPreview() {
    if (!state.scanImage) return null;
    const image = state.scanImage;
    const rotation = ((state.scanRotation % 360) + 360) % 360;
    const rotatedWidth = rotation % 180 === 0 ? image.naturalWidth : image.naturalHeight;
    const rotatedHeight = rotation % 180 === 0 ? image.naturalHeight : image.naturalWidth;
    const rotated = document.createElement('canvas');
    rotated.width = rotatedWidth;
    rotated.height = rotatedHeight;
    const rotatedContext = rotated.getContext('2d');
    if (!rotatedContext) throw new Error('Could not prepare the image for on-device recognition.');
    rotatedContext.translate(rotatedWidth / 2, rotatedHeight / 2);
    rotatedContext.rotate(rotation * Math.PI / 180);
    rotatedContext.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);

    const cropFraction = state.scanCropPercent / 100;
    const cropWidth = Math.max(1, Math.round(rotatedWidth * (1 - cropFraction * 2)));
    const cropHeight = Math.max(1, Math.round(rotatedHeight * (1 - cropFraction * 2)));
    const cropLeft = Math.round((rotatedWidth - cropWidth) / 2);
    const cropTop = Math.round((rotatedHeight - cropHeight) / 2);
    const scale = Math.min(1, 2000 / Math.max(cropWidth, cropHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(cropWidth * scale));
    canvas.height = Math.max(1, Math.round(cropHeight * scale));
    const context = canvas.getContext('2d', { willReadFrequently: true });
    if (!context) throw new Error('Could not prepare the image for on-device recognition.');
    context.drawImage(rotated, cropLeft, cropTop, cropWidth, cropHeight, 0, 0, canvas.width, canvas.height);
    const preview = $('#scanner-image-preview');
    preview.width = canvas.width;
    preview.height = canvas.height;
    preview.getContext('2d')?.drawImage(canvas, 0, 0);
    return canvas;
  }

  function scanImageQuality(canvas) {
    const sampleWidth = Math.min(160, canvas.width);
    const sampleHeight = Math.min(160, canvas.height);
    const sample = document.createElement('canvas');
    sample.width = sampleWidth;
    sample.height = sampleHeight;
    const sampleContext = sample.getContext('2d', { willReadFrequently: true });
    if (!sampleContext) return 'Image checks unavailable; inspect the preview before continuing.';
    sampleContext.drawImage(canvas, 0, 0, sampleWidth, sampleHeight);
    const pixels = sampleContext.getImageData(0, 0, sampleWidth, sampleHeight).data;
    let brightness = 0;
    let brightPixels = 0;
    let edgeDifference = 0;
    let edges = 0;
    const luminance = (x, y) => {
      const offset = (y * sampleWidth + x) * 4;
      return .2126 * pixels[offset] + .7152 * pixels[offset + 1] + .0722 * pixels[offset + 2];
    };
    for (let y = 0; y < sampleHeight; y += 1) {
      for (let x = 0; x < sampleWidth; x += 1) {
        const level = luminance(x, y);
        brightness += level;
        if (level > 248) brightPixels += 1;
        if (x > 0) {
          edgeDifference += Math.abs(level - luminance(x - 1, y));
          edges += 1;
        }
        if (y > 0) {
          edgeDifference += Math.abs(level - luminance(x, y - 1));
          edges += 1;
        }
      }
    }
    const count = sampleWidth * sampleHeight;
    const average = brightness / count;
    const hints = [];
    if (Math.min(canvas.width, canvas.height) < 400) hints.push('image is small');
    if (average < 55) hints.push('image may be dark');
    if (average > 225) hints.push('image may be overexposed');
    if (brightPixels / count > .2) hints.push('possible glare');
    if (edgeDifference / Math.max(1, edges) < 8) hints.push('image may be soft or out of focus');
    return hints.length
      ? `Image check: ${hints.join(', ')}. These are hints only; continue if the card text is readable.`
      : 'Image check looks usable. Still confirm the text and artwork; checks are approximate.';
  }

  async function setScanImage(image) {
    state.scanImage = image;
    state.scanRotation = 0;
    state.scanCropPercent = 0;
    $('#scanner-crop').value = '0';
    $('#scanner-crop-value').value = '0%';
    $('#scanner-image-editor').hidden = false;
    $('#scanner-camera-wrap').hidden = true;
    $('#scanner-results').replaceChildren();
    $('#scanner-ocr-text').textContent = 'Not analyzed yet';
    const preview = updateScanPreview();
    try {
      $('#scanner-quality').textContent = scanImageQuality(preview);
    } catch (error) {
      console.warn('Scanner image quality checks were unavailable:', error);
      $('#scanner-quality').textContent = 'Image checks could not run; inspect the preview and continue if the card text is readable.';
    }
    $('#scanner-status').textContent = 'Review the image, rotate or crop if needed, then identify it.';
    $('#scanner-retake').hidden = false;
  }

  async function loadScanImage(dataUrl) {
    const image = new Image();
    image.decoding = 'async';
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = () => reject(new Error('The selected image could not be opened. Choose another photo.'));
      image.src = dataUrl;
    });
    state.scanOriginalDataUrl = dataUrl;
    await setScanImage(image);
  }

  async function captureScanImage() {
    const video = $('#scanner-video');
    if (!video.videoWidth || !video.videoHeight) {
      $('#scanner-status').textContent = 'Camera is still starting. Wait a moment or upload a photo.';
      return;
    }
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 2000 / Math.max(video.videoWidth, video.videoHeight));
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    const context = canvas.getContext('2d');
    if (!context) {
      $('#scanner-status').textContent = 'Could not capture the camera image. Try uploading a photo.';
      return;
    }
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    await loadScanImage(canvas.toDataURL('image/jpeg', .92));
  }

  async function toggleScannerTorch() {
    const track = state.cameraStream?.getVideoTracks()[0];
    if (!track || $('#scanner-torch').disabled) return;
    const next = !state.scanTorchEnabled;
    try {
      await track.applyConstraints({ advanced: [{ torch: next }] });
      state.scanTorchEnabled = next;
      $('#scanner-torch').setAttribute('aria-pressed', String(next));
      $('#scanner-torch').textContent = next ? 'Turn flashlight off' : 'Flashlight';
    } catch (error) {
      console.warn('Camera flashlight could not be changed:', error);
      $('#scanner-status').textContent = 'This camera could not change its flashlight setting.';
    }
  }

  async function identifyCapturedCard() {
    if (!state.scanImage || state.scanRunning) {
      $('#scanner-status').textContent = 'Capture or upload a card image before identifying it.';
      return;
    }
    let canvas;
    try {
      canvas = updateScanPreview();
    } catch (error) {
      $('#scanner-status').textContent = error.message;
      return;
    }
    state.scanRunning = true;
    $('#scanner-identify').disabled = true;
    $('#scanner-results').replaceChildren();
    $('#scanner-status').textContent = 'Reading visible card text on this device…';
    let worker;
    try {
      const Tesseract = await loadOcrLibrary();
      worker = await Tesseract.createWorker('eng', 1, {
        logger: (message) => {
          if (message.status === 'recognizing text' && $('#scanner-dialog').open) {
            $('#scanner-status').textContent = `Reading card text… ${Math.round(message.progress * 100)}%`;
          }
        }
      });
      state.scanWorker = worker;
      const { data } = await worker.recognize(canvas);
      if (!$('#scanner-dialog').open) return;
      const ocrText = String(data.text || '').trim();
      $('#scanner-ocr-text').textContent = ocrText || 'No readable text found.';
      const number = scanNumberFromText(ocrText);
      const species = findScannedPokemon(ocrText);
      const nameQuery = species
        ? pokemonSearchTerm(species.name)
        : ocrText.split(/\r?\n/)
          .map((line) => line.replace(/[^a-zA-Z0-9' -]/g, '').trim())
          .find((line) => line.length >= 4 && line.length <= 45 && /[a-z]{3}/i.test(line));
      if (!nameQuery) {
        $('#scanner-status').textContent = 'Card not confidently identified. No usable name was read; search the catalog manually or try another image.';
        renderScanResults([]);
        return;
      }
      const searchName = String(nameQuery).split(/\s+/).slice(0, 5).join(' ');
      $('#scanner-search').value = species ? formatPokemonName(species.name) : searchName;
      await queryScanCatalog(searchName, ocrText, species, number, false);
    } catch (error) {
      if ($('#scanner-dialog').open) {
        console.error('Could not identify scanned card:', error);
        $('#scanner-status').textContent = 'On-device text recognition failed. Search the catalog manually or try another image.';
        $('#scanner-results').innerHTML = `<p class="scanner-no-results">${escapeHtml(error.message || 'Recognition could not be completed.')}</p>`;
      }
    } finally {
      if (worker && state.scanWorker === worker) {
        await worker.terminate().catch((error) => console.warn('Could not stop text recognition worker cleanly:', error));
        state.scanWorker = null;
      }
      state.scanRunning = false;
      if ($('#scanner-dialog').open) $('#scanner-identify').disabled = false;
    }
  }

  function scannerDuplicateWarning(entry) {
    const selectedVariant = entry.variant === '__custom__' ? entry.customVariant.trim() : entry.variant;
    const ownedCopies = state.data.owned
      .filter((owned) => owned.cardId === entry.card.id && owned.variant === selectedVariant &&
        canonicalLanguage(owned.language || entry.card.lang || '') === canonicalLanguage(entry.language) &&
        (owned.condition || 'Near Mint') === entry.condition)
      .reduce((count, owned) => count + owned.copies.length, 0);
    return ownedCopies
      ? `<p class="scanner-duplicate-warning" role="status">You already have ${ownedCopies} ${escapeHtml(entry.condition)} ${escapeHtml(selectedVariant)} ${ownedCopies === 1 ? 'copy' : 'copies'} of this print in ${escapeHtml(entry.language)}. Adding is allowed if these are additional copies.</p>`
      : '';
  }

  function renderScanQueue() {
    const queue = $('#scanner-queue');
    $('#scanner-queue-count').textContent = `${state.scanQueue.length} ${state.scanQueue.length === 1 ? 'card' : 'cards'}`;
    $('#scanner-queue-save').disabled = state.scanQueue.length === 0 || state.savingCard;
    queue.innerHTML = state.scanQueue.length
      ? state.scanQueue.map((entry) => {
        const card = entry.card;
        const art = card.images?.small || card.images?.large;
        const variants = new Set([...Object.keys(card.tcgplayer?.prices || {}), 'normal']);
        return `<article class="scanner-queue-item" data-queue-id="${escapeAttribute(entry.id)}">
          <div class="scanner-queue-card">
            ${art ? `<img src="${escapeAttribute(art)}" alt="" loading="lazy">` : '<span class="scanner-result-no-art">Artwork unavailable</span>'}
            <div><strong>${escapeHtml(card.name)}</strong><span>${escapeHtml(card.set?.name || 'Set unavailable')} · ${escapeHtml(cardSetNumber(card) || 'Number unavailable')}</span><span>${escapeHtml(cardLanguage(card))} · ${escapeHtml(card.rarity || 'Rarity unavailable')}</span><small>Match manually confirmed by you</small></div>
          </div>
          <div class="scanner-queue-fields">
            <label>Copies<input data-queue-field="quantity" type="number" min="1" max="25" step="1" value="${escapeAttribute(entry.quantity)}" inputmode="numeric"></label>
            <label>Condition<select data-queue-field="condition">${['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'].map((condition) => `<option${entry.condition === condition ? ' selected' : ''}>${condition}</option>`).join('')}</select></label>
            <label>Language<input data-queue-field="language" type="text" maxlength="40" value="${escapeAttribute(entry.language)}"></label>
            <label>Acquisition<select data-queue-field="method">${[['purchased', 'Purchased'], ['traded', 'Traded'], ['gifted', 'Gifted'], ['pulled-from-pack', 'Pulled from pack']].map(([value, label]) => `<option value="${value}"${entry.method === value ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
            <label>Printing<select data-queue-field="variant">${[...variants].map((key) => {
              const value = displayVariant(key);
              const noQuote = cardPrice(card, key) === null ? ' · no quote' : '';
              return `<option value="${escapeAttribute(value)}"${entry.variant === value ? ' selected' : ''}>${escapeHtml(value + noQuote)}</option>`;
            }).join('')}<option value="__custom__"${entry.variant === '__custom__' ? ' selected' : ''}>Other / special printing…</option></select></label>
            <label class="scanner-queue-custom-variant"${entry.variant === '__custom__' ? '' : ' hidden'}>Describe printing<input data-queue-field="customVariant" type="text" maxlength="80" value="${escapeAttribute(entry.customVariant)}" placeholder="e.g. League stamp, staff promo"></label>
            <label>Price paid · each<input data-queue-field="paid" type="number" min="0" step="0.01" value="${escapeAttribute(entry.paid)}" inputmode="decimal" placeholder="Optional"></label>
            <label>Purchase / acquisition date<input data-queue-field="date" type="date" value="${escapeAttribute(entry.date)}"></label>
            <label>Seller / source<input data-queue-field="seller" type="text" maxlength="100" value="${escapeAttribute(entry.seller)}" placeholder="Optional"></label>
            <label class="scanner-queue-notes">Notes<input data-queue-field="note" type="text" maxlength="500" value="${escapeAttribute(entry.note)}" placeholder="Optional"></label>
          </div>
          <div class="scanner-duplicate-warning-slot">${scannerDuplicateWarning(entry)}</div>
          <div class="scanner-queue-actions">
            <button class="button button-secondary" type="button" data-queue-action="rescan" data-queue-id="${escapeAttribute(entry.id)}">Rescan / replace match</button>
            <button class="button button-secondary" type="button" data-queue-action="remove" data-queue-id="${escapeAttribute(entry.id)}">Remove</button>
          </div>
        </article>`;
      }).join('')
      : '<p class="scanner-queue-empty">No cards queued. Identify an image or search the catalog, then add a confirmed candidate.</p>';
  }

  function addScanCandidate(cardId) {
    const card = state.scannedCards.find((candidate) => candidate.id === cardId);
    if (!card) {
      $('#scanner-status').textContent = 'That catalog result is no longer available. Search again before queuing it.';
      return;
    }
    const replacement = state.scanQueue.findIndex((entry) => entry.id === state.scanRescanQueueId);
    const entry = {
      id: state.scanRescanQueueId || crypto.randomUUID(),
      card,
      quantity: replacement >= 0 ? state.scanQueue[replacement].quantity : 1,
      condition: replacement >= 0 ? state.scanQueue[replacement].condition : 'Near Mint',
      variant: replacement >= 0 ? state.scanQueue[replacement].variant : displayVariant(primaryVariant(card)),
      customVariant: replacement >= 0 ? state.scanQueue[replacement].customVariant : '',
      language: replacement >= 0 ? state.scanQueue[replacement].language : cardLanguage(card),
      method: replacement >= 0 ? state.scanQueue[replacement].method : 'purchased',
      paid: replacement >= 0 ? state.scanQueue[replacement].paid : '',
      date: replacement >= 0 ? state.scanQueue[replacement].date : localDateInputValue(),
      seller: replacement >= 0 ? state.scanQueue[replacement].seller : '',
      note: replacement >= 0 ? state.scanQueue[replacement].note : ''
    };
    if (replacement >= 0) state.scanQueue.splice(replacement, 1, entry);
    else state.scanQueue.push(entry);
    state.scanRescanQueueId = '';
    renderScanQueue();
    $('#scanner-status').textContent = `${card.name} ${replacement >= 0 ? 'match replaced in' : 'added to'} the review queue.`;
    $('#scanner-results').replaceChildren();
  }

  function handleScanUpload(file) {
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      $('#scanner-status').textContent = 'Choose an image file such as JPEG, PNG, or HEIC if your browser can decode it.';
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      $('#scanner-status').textContent = 'Images must be 20 MB or smaller. Choose a smaller image.';
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => {
      $('#scanner-status').textContent = 'Could not read this image file. Choose another photo or search manually.';
    };
    reader.onload = async () => {
      try {
        if (typeof reader.result !== 'string') throw new Error('The selected image could not be read.');
        await loadScanImage(reader.result);
      } catch (error) {
        console.error('Could not load uploaded scanner image:', error);
        $('#scanner-status').textContent = error.message || 'Could not open the selected image.';
      }
    };
    reader.readAsDataURL(file);
  }

  async function saveScanQueue() {
    if (state.savingCard || !state.scanQueue.length) return;
    const entries = [...state.scanQueue];
    for (const [index, entry] of entries.entries()) {
      const quantity = Number(entry.quantity);
      const paid = entry.paid === '' ? 0 : Number(entry.paid);
      if (!Number.isInteger(quantity) || quantity < 1 || quantity > 25) {
        $('#scanner-status').textContent = `Queue card ${index + 1}: enter a quantity from 1 to 25.`;
        return;
      }
      if (!Number.isFinite(paid) || paid < 0) {
        $('#scanner-status').textContent = `Queue card ${index + 1}: enter a valid price or leave it blank.`;
        return;
      }
      if (!entry.language.trim()) {
        $('#scanner-status').textContent = `Queue card ${index + 1}: enter a language before saving.`;
        return;
      }
      if (entry.variant === '__custom__' && !entry.customVariant.trim()) {
        $('#scanner-status').textContent = `Queue card ${index + 1}: describe the special printing or choose a catalog treatment.`;
        return;
      }
      if (!/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
          !Number.isFinite(new Date(`${entry.date}T12:00:00`).getTime())) {
        $('#scanner-status').textContent = `Queue card ${index + 1}: choose a valid purchase date.`;
        return;
      }
    }

    state.savingCard = true;
    $('#scanner-queue-save').disabled = true;
    const savedIds = new Set();
    try {
      for (const [index, entry] of entries.entries()) {
        $('#scanner-status').textContent = `Saving confirmed card ${index + 1} of ${entries.length}…`;
        const card = entry.card;
        const metadata = {
          pokemon: cardPokemonId(card) || '',
          cardName: card.name || '',
          setName: card.set?.name || '',
          cardNumber: cardSetNumber(card) || card.number || '',
          rarity: card.rarity || '',
          language: displayLanguage(entry.language),
          storageLocation: '',
          binderPage: '',
          note: entry.note.trim(),
          tags: []
        };
        const copies = Array.from({ length: Number(entry.quantity) }, () => ({
          condition: entry.condition,
          paid: entry.paid === '' ? 0 : Number(entry.paid),
          addedAt: entry.date,
          acquisitionMethod: entry.method,
          seller: entry.seller.trim(),
          location: '',
          binderPage: '',
          gradeStatus: 'ungraded',
          gradingCompany: '',
          officialGrade: '',
          certificationNumber: ''
        }));
        const variant = entry.variant === '__custom__' ? entry.customVariant.trim() : entry.variant;
        if (!addOwned(card, variant, copies, $('#scanner-budget-check').checked, metadata)) {
          state.scanQueue = state.scanQueue.filter((queued) => !savedIds.has(queued.id));
          renderScanQueue();
          $('#scanner-status').textContent = `Saving stopped at card ${index + 1}. Earlier cards were saved; the remaining queue is still available to retry.`;
          return;
        }
        savedIds.add(entry.id);
      }
      state.scanQueue = state.scanQueue.filter((entry) => !savedIds.has(entry.id));
      renderScanQueue();
      renderCatalog();
      loadOwnedCards();
      $('#scanner-status').textContent = `${savedIds.size} confirmed ${savedIds.size === 1 ? 'card was' : 'cards were'} added to your collection.`;
      showToast(`${savedIds.size} ${savedIds.size === 1 ? 'card' : 'cards'} added from the scan queue.`);
    } finally {
      state.savingCard = false;
      renderScanQueue();
    }
  }

  function variantOptions(card) {
    const keys = new Set(Object.keys(card.tcgplayer?.prices || {}));
    keys.add('normal');
    return [...keys].map((key) => `<option value="${escapeHtml(key)}">${escapeHtml(displayVariant(key))}${cardPrice(card, key) === null ? ' · no quote' : ''}</option>`).join('') +
      '<option value="custom">Other / special treatment…</option>';
  }

  function copyRowsFromForm() {
    return [...$('#copy-record-list').querySelectorAll('.copy-record-row')].map((row) => ({
      id: row.dataset.copyId || '',
      condition: row.querySelector('[data-copy-condition]').value,
      paid: row.querySelector('[data-copy-paid]').value,
      addedAt: row.querySelector('[data-copy-date]').value,
      acquisitionMethod: row.querySelector('[data-copy-method]').value,
      seller: row.querySelector('[data-copy-seller]').value.trim(),
      location: row.querySelector('[data-copy-location]').value.trim(),
      binderPage: row.querySelector('[data-copy-slot]').value.trim(),
      gradeStatus: row.querySelector('[data-copy-grade-status]').value,
      gradingCompany: row.querySelector('[data-copy-company]').value.trim(),
      officialGrade: row.querySelector('[data-copy-grade]').value.trim(),
      certificationNumber: row.querySelector('[data-copy-certification]').value.trim(),
      budgetTracked: row.dataset.budgetTracked === 'true'
    }));
  }

  function renderCopyRows(copies, count, defaults = {}) {
    const records = Array.from({ length: count }, (_, index) => copies[index] || {
      condition: defaults.condition || 'Near Mint',
      paid: defaults.paid ?? '',
      addedAt: defaults.addedAt || localDateInputValue(),
      acquisitionMethod: defaults.acquisitionMethod || 'purchased',
      seller: defaults.seller || '',
      location: defaults.location || '',
      binderPage: defaults.binderPage || '',
      gradeStatus: 'ungraded',
      gradingCompany: '',
      officialGrade: '',
      certificationNumber: ''
    });
    const conditions = ['Near Mint', 'Lightly Played', 'Moderately Played', 'Heavily Played', 'Damaged'];
    const methods = [
      ['purchased', 'Purchased'],
      ['traded', 'Traded'],
      ['gifted', 'Gifted'],
      ['pack-pull', 'Pulled from a pack'],
      ['other', 'Other']
    ];
    $('#copy-record-list').innerHTML = records.map((copy, index) => {
      const graded = copy.gradeStatus === 'graded' || Boolean(copy.gradingCompany || copy.officialGrade || copy.certificationNumber);
      return `<article class="copy-record-row" data-copy-id="${escapeAttribute(copy.id || '')}" data-budget-tracked="${copy.budgetTracked ? 'true' : 'false'}">
        <header><strong>Copy ${index + 1}</strong><span>Details saved per copy</span></header>
        <div class="copy-record-main">
          <label class="inventory-field"><span>Condition</span><select class="field-control" data-copy-condition>${conditions.map((condition) => `<option${condition === (copy.condition || 'Near Mint') ? ' selected' : ''}>${condition}</option>`).join('')}</select></label>
          <label class="inventory-field"><span>Price paid · USD</span><input class="field-control" data-copy-paid type="number" min="0" step="0.01" inputmode="decimal" value="${escapeAttribute(copy.paid ?? '')}" placeholder="0.00"></label>
          <label class="inventory-field"><span>Acquisition</span><select class="field-control" data-copy-method>${methods.map(([value, label]) => `<option value="${value}"${value === (copy.acquisitionMethod || 'purchased') ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
        </div>
        <details class="copy-record-more"${graded ? ' open' : ''}>
          <summary>Purchase, storage &amp; grading details</summary>
          <div class="copy-record-extra">
            <label class="inventory-field"><span>Acquisition date</span><input class="field-control" data-copy-date type="date" value="${escapeAttribute(dateForInput(copy.addedAt))}"></label>
            <label class="inventory-field"><span>Seller or source</span><input class="field-control" data-copy-seller type="text" maxlength="100" value="${escapeAttribute(copy.seller || '')}" placeholder="Shop, trade partner, or event"></label>
            <label class="inventory-field"><span>Storage location</span><input class="field-control" data-copy-location type="text" maxlength="100" value="${escapeAttribute(copy.location || '')}" placeholder="Binder or storage box"></label>
            <label class="inventory-field"><span>Binder page / slot</span><input class="field-control" data-copy-slot type="text" maxlength="60" value="${escapeAttribute(copy.binderPage || '')}" placeholder="Page 4 · slot 3"></label>
            <label class="inventory-field copy-grade-status"><span>Grading status</span><select class="field-control" data-copy-grade-status><option value="ungraded"${graded ? '' : ' selected'}>Ungraded</option><option value="graded"${graded ? ' selected' : ''}>Officially graded</option></select></label>
            <div class="copy-grade-fields"${graded ? '' : ' hidden'}>
              <label class="inventory-field"><span>Grading company</span><input class="field-control" data-copy-company type="text" maxlength="40" value="${escapeAttribute(copy.gradingCompany || '')}" placeholder="PSA, CGC, BGS…"></label>
              <label class="inventory-field"><span>Official grade</span><input class="field-control" data-copy-grade type="text" maxlength="20" value="${escapeAttribute(copy.officialGrade || '')}" placeholder="As printed on label"></label>
              <label class="inventory-field"><span>Certification number</span><input class="field-control" data-copy-certification type="text" maxlength="60" value="${escapeAttribute(copy.certificationNumber || '')}" placeholder="Optional"></label>
              <small>Enter only details printed by the grading company. Aura Vault does not estimate grades.</small>
            </div>
          </div>
        </details>
      </article>`;
    }).join('');
    updateInventorySummary();
  }

  function inventoryMetadata() {
    return {
      pokemon: $('#entry-pokemon').value.trim(),
      cardName: $('#entry-card-name').value.trim(),
      setName: $('#entry-set-name').value.trim(),
      cardNumber: $('#entry-card-number').value.trim(),
      rarity: $('#entry-rarity').value.trim(),
      language: $('#entry-language').value.trim(),
      storageLocation: $('#entry-storage').value.trim(),
      binderPage: $('#entry-slot').value.trim(),
      note: $('#notes-input').value.trim(),
      tags: $('#entry-tags').value.split(',').map((tag) => tag.trim()).filter(Boolean).slice(0, 20)
    };
  }

  function updateDuplicateWarning() {
    const warning = $('#duplicate-warning');
    const action = $('#dialog-action').value;
    const card = state.dialogCard;
    if (!card || (action !== 'owned' && action !== 'edit')) {
      warning.hidden = true;
      return;
    }

    const selected = $('#variant-select').value;
    const variant = selected === 'custom' ? $('#custom-variant').value.trim() : displayVariant(selected);
    const language = $('#entry-language').value.trim() || card.lang || '';
    const conditions = new Set(copyRowsFromForm().map((copy) => copy.condition));
    const matches = state.data.owned.filter((item, index) =>
      !(action === 'edit' && index === state.editingGroupIndex) &&
      item.cardId === card.id &&
      item.variant === variant &&
      conditions.has(item.condition || 'Near Mint') &&
      (item.language || card.lang || '') === language);
    const countsByCondition = [...conditions].map((condition) => ({
      condition,
      count: matches
        .filter((item) => (item.condition || 'Near Mint') === condition)
        .reduce((total, item) => total + item.copies.length, 0)
    })).filter((item) => item.count > 0);

    warning.hidden = countsByCondition.length === 0;
    warning.textContent = countsByCondition.length
      ? `Already recorded ${countsByCondition.map(({ condition, count }) => `${count} ${condition} ${variant} ${count === 1 ? 'copy' : 'copies'}`).join(', ')}${language ? ` in ${language}` : ''}. Add only if these are additional physical copies.`
      : '';
  }

  function updateInventorySummary() {
    const action = $('#dialog-action').value;
    if (action !== 'owned' && action !== 'edit') return;
    const copies = copyRowsFromForm();
    const purchaseTotal = copies.reduce((total, copy) => {
      const amount = Number(copy.paid);
      return total + (Number.isFinite(amount) && amount >= 0 ? amount : 0);
    }, 0);
    const card = state.dialogCard;
    const variant = $('#variant-select').value === 'custom'
      ? keyForVariant($('#custom-variant').value)
      : $('#variant-select').value;
    const market = card ? cardPrice(card, variant) : null;
    const marketTotal = market === null ? null : market * copies.length;
    $('#dialog-purchase-total').textContent = formatMoney(purchaseTotal);
    $('#dialog-market-value').textContent = marketTotal === null
      ? 'Unavailable'
      : `${formatMoney(marketTotal)}${isStale(card) ? ' · stale' : ''}`;
    const sourceDate = card?.tcgplayer?.updatedAt
      ? ` · updated ${new Date(card.tcgplayer.updatedAt).toLocaleDateString()}`
      : '';
    $('#dialog-market-source').textContent = marketTotal === null
      ? 'Pokémon TCG API · unavailable for this treatment'
      : `Pokémon TCG API · estimate only${sourceDate}`;
    $('#dialog-value-difference').textContent = marketTotal === null
      ? 'Unavailable'
      : `${marketTotal - purchaseTotal >= 0 ? '+' : '−'}${formatMoney(Math.abs(marketTotal - purchaseTotal))}`;
  }

  function inventoryCardPreview(card, editing) {
    const art = card.images?.large || card.images?.small;
    const price = cardPrice(card, primaryVariant(card));
    const updatedAt = card.tcgplayer?.updatedAt;
    return `<div class="inventory-preview-art">${art
      ? `<img src="${escapeAttribute(art)}" alt="${escapeAttribute(card.name)} card artwork">`
      : '<span class="no-art" role="img" aria-label="Card artwork unavailable">Card art unavailable</span>'}</div>
      <div class="inventory-preview-copy">
        <span class="inventory-preview-kicker">${editing ? 'EDITING SAVED PRINT' : 'ADDING THIS PRINT'}</span>
        <strong>${escapeHtml(card.name || 'Card name unavailable')}</strong>
        <span>${escapeHtml(card.set?.name || 'Set unavailable')} · ${escapeHtml(cardSetNumber(card) || 'Number unavailable')} · ${escapeHtml(card.rarity || 'Rarity unavailable')}</span>
        <span>${escapeHtml(card.lang || 'English')} · ${price === null ? 'Market estimate unavailable' : `Estimated market ${formatMoney(price)}${isStale(card) ? ' · stale' : ''}`}${updatedAt ? ` · updated ${new Date(updatedAt).toLocaleDateString()}` : ''}</span>
      </div>`;
  }

  function updateDialogPrice() {
    updateInventorySummary();
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
    const tcgplayerLink = $('#tcgplayer-link');
    tcgplayerLink.href = `https://www.tcgplayer.com/search/pokemon/product?productLineName=pokemon&q=${encoded}`;
    $('#pricecharting-link').href = `https://www.pricecharting.com/search-products?type=prices&q=${encoded}`;
    $('#ebay-sold-link').href = `https://www.ebay.com/sch/i.html?_nkw=${encoded}&_sacat=0&LH_Sold=1&LH_Complete=1`;
    $('#ebay-active-link').href = `https://www.ebay.com/sch/i.html?_nkw=${encoded}&_sacat=0`;
  }

  function openPricesDialog(card) {
    state.pricesCard = card;
    $('#prices-title').textContent = `Compare ${card.name} prices`;
    $('#prices-card-details').textContent = `${card.set?.name || 'Set unavailable'} · ${cardSetNumber(card) || '?'} · ${card.rarity || 'Rarity not listed'}`;
    const keys = [...new Set([...Object.keys(card.tcgplayer?.prices || {}), 'normal'])];
    $('#prices-variant').innerHTML = keys.map((key) =>
      `<option value="${escapeHtml(key)}">${escapeHtml(displayVariant(key))}</option>`
    ).join('');
    $('#prices-dialog').showModal();
    updatePriceLinks();
  }

  function openDetailsDialog(card) {
    const ownedEntries = state.data.owned.map((item, index) => ({ item, index })).filter(({ item }) => item.cardId === card.id);
    const market = cardPrice(card, pricesFor(card)[0] || 'normal');
    const art = card.images?.large || card.images?.small;
    const entryMarkup = ownedEntries.length ? ownedEntries.map(({ item, index }) => {
      const paid = item.copies.reduce((sum, copy) => sum + Number(copy.paid || 0), 0);
      const entryPrice = cardPrice(card, keyForVariant(item.variant));
      const marketTotal = entryPrice === null ? null : entryPrice * item.copies.length;
      const copySummary = item.copies.map((copy, copyIndex) => {
        const details = [
          `Copy ${copyIndex + 1}`,
          copy.addedAt ? new Date(copy.addedAt).toLocaleDateString() : 'purchase date unavailable',
          `paid ${formatMoney(Number(copy.paid || 0))}`,
          copy.acquisitionMethod ? copy.acquisitionMethod.replace('-', ' ') : '',
          copy.seller ? `from ${copy.seller}` : '',
          copy.location ? `stored ${copy.location}` : copy.storageLocation ? `stored ${copy.storageLocation}` : '',
          copy.binderPage ? `slot ${copy.binderPage}` : '',
          copy.gradingStatus === 'graded' ? `Official grade: ${copy.gradingCompany || 'company unavailable'} ${copy.officialGrade || ''}${copy.certificationNumber ? ` · cert ${copy.certificationNumber}` : ''}` : ''
        ].filter(Boolean).join(' · ');
        return `<p class="detail-purchase-record">${escapeHtml(details)}</p>`;
      }).join('');
      return `<section class="detail-entry">
        <h3>${escapeHtml(item.variant)} · ${escapeHtml(item.condition)} · ${escapeHtml(item.language || 'Language not recorded')} · ${item.copies.length} ${item.copies.length === 1 ? 'copy' : 'copies'}</h3>
        <div class="detail-metrics"><div class="detail-metric"><span>PURCHASE COST · TOTAL PAID</span><strong>${formatMoney(paid)}</strong></div><div class="detail-metric"><span>EST. MARKET · ALL COPIES</span><strong>${marketTotal === null ? 'Unavailable' : `${formatMoney(marketTotal)}${isStale(card) ? ' · stale' : ''}`}</strong></div></div>
        ${copySummary}
        ${item.note ? `<p>Note: ${escapeHtml(item.note)}</p>` : ''}${item.tags?.length ? `<p>Tags: ${escapeHtml(item.tags.join(', '))}</p>` : ''}
        <div class="detail-actions"><button class="button button-secondary" type="button" data-action="edit-entry" data-card-id="${escapeAttribute(card.id)}" data-group-index="${index}">Edit details</button><button class="button detail-delete" type="button" data-action="delete-entry" data-card-id="${escapeAttribute(card.id)}" data-group-index="${index}">Delete entry</button></div>
      </section>`;
    }).join('') : '<div class="empty-inline">Not in your collection yet. Add it to record condition, acquisition price, and notes.</div>';
    const wishlistItem = state.data.wishlist.find((item) => item.cardId === card.id);
    $('#detail-content').innerHTML = `<div class="detail-hero">
      <div class="detail-art-wrap">${art ? `<img class="detail-art" src="${escapeAttribute(art)}" alt="${escapeAttribute(card.name)} card artwork">` : '<div class="no-art">L</div>'}</div>
      <div class="detail-meta"><div class="dialog-eyebrow">${escapeHtml(ownedEntries[0]?.item.rarity || card.rarity || 'CARD DETAILS')}</div><h2>${escapeHtml(ownedEntries[0]?.item.cardName || card.name)}</h2><p>${escapeHtml(ownedEntries[0]?.item.setName || card.set?.name || 'Set unavailable')} · ${escapeHtml(ownedEntries[0]?.item.cardNumber || cardSetNumber(card) || '?')} · ${escapeHtml(ownedEntries[0]?.item.language || card.lang || 'Language unavailable')}</p>
        <div class="detail-metrics"><div class="detail-metric"><span>MARKET ESTIMATE${market !== null && isStale(card) ? ' · STALE' : ''}</span><strong>${market === null ? 'Unavailable' : formatMoney(market)}</strong></div><div class="detail-metric"><span>COLLECTION</span><strong>${ownedEntries.reduce((sum, { item }) => sum + item.copies.length, 0)} owned</strong></div></div>
      </div></div>
      <div class="detail-actions"><button class="button button-primary" type="button" data-action="detail-add" data-card-id="${escapeAttribute(card.id)}">＋ Add to collection</button><button class="button button-secondary" type="button" data-action="detail-price" data-card-id="${escapeAttribute(card.id)}">Compare prices</button><button class="button button-secondary" type="button" data-action="detail-wishlist" data-card-id="${escapeAttribute(card.id)}">${cardWished(card.id) ? '♥ On wishlist' : '♡ Add to wishlist'}</button>${wishlistItem ? `<button class="button button-secondary" type="button" data-action="detail-wishlist-edit" data-card-id="${escapeAttribute(card.id)}">Edit wishlist target</button>` : ''}</div>
      <h3 class="detail-section-title">Your copies</h3>${entryMarkup}`;
    $('#detail-dialog').showModal();
  }

  function openCardDialog(card, action, groupIndex = null) {
    state.dialogCard = card;
    state.editingGroupIndex = action === 'edit' ? groupIndex : null;
    state.editingWishlistIndex = action === 'wishlist-edit' ? groupIndex : null;
    $('#dialog-submit').disabled = false;
    $('#dialog-add-another').disabled = false;
    $('#dialog-action').value = action;
    $('#dialog-card-id').value = card.id;
    const editing = action === 'edit' && Number.isInteger(groupIndex) ? state.data.owned[groupIndex] : null;
    const wishlistEntry = action === 'wishlist-edit'
      ? state.data.wishlist[groupIndex] || state.data.wishlist.find((item) => item.cardId === card.id)
      : null;
    const isWishlistAction = action === 'wishlist' || action === 'wishlist-edit';
    $('#dialog-eyebrow').textContent = isWishlistAction ? (wishlistEntry ? 'EDIT WISHLIST' : 'WISHLIST') : editing ? 'EDIT COLLECTION ENTRY' : 'COLLECTION';
    $('#dialog-title').textContent = isWishlistAction ? (wishlistEntry ? 'Update wishlist card' : 'Add to wishlist') : editing ? 'Edit collection details' : 'Add to Collection';
    $('#dialog-submit').textContent = isWishlistAction ? (wishlistEntry ? 'Update wishlist' : 'Save to wishlist') : editing ? 'Save details' : 'Add to Collection';
    $('#inventory-card-preview').innerHTML = inventoryCardPreview(card, Boolean(editing));
    $('#condition-fields').hidden = isWishlistAction;
    $('#wishlist-fields').hidden = !isWishlistAction;
    $('#quantity-label').hidden = Boolean(editing) || isWishlistAction;
    $('#budget-check').closest('.check-label').hidden = Boolean(editing);
    $('#dialog-add-another').hidden = Boolean(editing) || isWishlistAction;
    $('#dialog-market-summary').hidden = isWishlistAction;
    $('#duplicate-warning').hidden = true;
    $('#purchase-quantity').value = String(editing?.copies.length || 1);
    $('#target-price-input').value = wishlistEntry?.targetPrice ?? '';
    $('#wishlist-priority').value = wishlistEntry?.priority || 'normal';
    $('#budget-check').checked = true;
    $('#entry-pokemon').value = editing?.pokemon || formatPokemonName(cardPokemonId(card) || state.selectedPokemon);
    $('#entry-card-name').value = editing?.cardName || card.name || '';
    $('#entry-set-name').value = editing?.setName || card.set?.name || '';
    $('#entry-card-number').value = editing?.cardNumber || cardSetNumber(card) || '';
    $('#entry-rarity').value = editing?.rarity || card.rarity || '';
    $('#entry-language').value = editing?.language || card.lang || 'English';
    $('#entry-storage').value = editing?.storageLocation || '';
    $('#entry-slot').value = editing?.binderPage || '';
    $('#notes-input').value = editing?.note || '';
    $('#entry-tags').value = Array.isArray(editing?.tags) ? editing.tags.join(', ') : '';
    $('#variant-select').innerHTML = variantOptions(card);
    if (editing || wishlistEntry) {
      const existingKey = keyForVariant(editing?.variant || wishlistEntry.variant);
      if ([...$('#variant-select').options].some((option) => option.value === existingKey)) $('#variant-select').value = existingKey;
      else {
        $('#variant-select').value = 'custom';
        $('#custom-variant').value = editing?.variant || wishlistEntry.variant;
      }
    }
    if (!editing && !wishlistEntry) $('#custom-variant').value = '';
    const customSelected = $('#variant-select').value === 'custom';
    $('#custom-variant-label').hidden = !customSelected;
    $('#custom-variant').hidden = !customSelected;
    $('#custom-variant-note').hidden = !customSelected;
    const copyDefaults = editing?.copies[0] || {};
    const copies = editing
      ? editing.copies.map((copy) => ({
        ...copy,
        condition: copy.condition || editing.condition,
        location: copy.location || editing.storageLocation || '',
        binderPage: copy.binderPage || editing.binderPage || ''
      }))
      : [];
    renderCopyRows(copies, editing ? copies.length : 1, {
      condition: editing?.condition || 'Near Mint',
      paid: copyDefaults.paid ?? '',
      addedAt: copyDefaults.addedAt || localDateInputValue(),
      seller: copyDefaults.seller || '',
      location: editing?.storageLocation || '',
      binderPage: editing?.binderPage || ''
    });
    updateDuplicateWarning();
    $('#card-dialog').showModal();
    updateDialogPrice();
  }

  function renderCardPicker() {
    const query = $('#card-picker-search').value.trim().toLowerCase();
    const matches = state.cards.filter((card) =>
      [card.name, card.set?.name, card.number, card.rarity, card.lang]
        .some((value) => String(value || '').toLowerCase().includes(query)));
    $('#card-picker-results').innerHTML = matches.length
      ? matches.map((card) => {
        const art = card.images?.small || card.images?.large;
        return `<button class="card-picker-option" type="button" data-picker-card-id="${escapeAttribute(card.id)}">
          <span class="card-picker-art">${art ? `<img src="${escapeAttribute(art)}" alt="" loading="lazy">` : '<span aria-hidden="true">TCG</span>'}</span>
          <span class="card-picker-copy"><strong>${escapeHtml(card.name)}</strong><span>${escapeHtml(card.set?.name || 'Set unavailable')} · ${escapeHtml(cardSetNumber(card) || 'Number unavailable')}</span><small>${escapeHtml(card.rarity || 'Rarity unavailable')} · ${escapeHtml(card.lang || 'English')}</small></span>
          <span class="card-picker-arrow" aria-hidden="true">›</span>
        </button>`;
      }).join('')
      : `<div class="card-picker-empty">${state.cards.length
        ? 'No catalog cards match that search. Try a different name, set, or number.'
        : 'No catalog is loaded yet. Choose a Pokémon and sync its catalog, then try again.'}</div>`;
  }

  function openCardPicker() {
    navigateTo('collection');
    if (!state.cards.length) {
      showToast('Load a Pokémon card catalog before adding a catalog print.');
      if (!state.loading) loadCatalog();
      return;
    }
    $('#card-picker-search').value = '';
    renderCardPicker();
    $('#card-picker-dialog').showModal();
  }

  function groupOwnedCopies(card, variant, copies, metadata, template = null) {
    const groups = new Map();
    for (const copy of copies) {
      const condition = copy.condition || 'Near Mint';
      const key = `${condition}\u0000${metadata.language || card.lang || ''}`;
      if (!groups.has(key)) {
        groups.set(key, {
          ...(template || {}),
          ...metadata,
          cardId: card.id,
          variant,
          verifiedVariant: Object.hasOwn(card.tcgplayer?.prices || {}, keyForVariant(variant)),
          condition,
          language: metadata.language || card.lang || '',
          copies: []
        });
      }
      const purchasedAt = isoForLocalDate(copy.addedAt);
      groups.get(key).copies.push({
        ...copy,
        id: copy.id || crypto.randomUUID(),
        paid: Number(copy.paid || 0),
        addedAt: purchasedAt,
        acquisitionMethod: copy.acquisitionMethod || 'purchased',
        seller: copy.seller || '',
        location: copy.location || metadata.storageLocation || '',
        storageLocation: copy.location || metadata.storageLocation || '',
        binderPage: copy.binderPage || metadata.binderPage || '',
        gradingStatus: copy.gradeStatus === 'graded' ? 'graded' : 'ungraded',
        gradingCompany: copy.gradeStatus === 'graded' ? copy.gradingCompany : '',
        officialGrade: copy.gradeStatus === 'graded' ? copy.officialGrade : '',
        certificationNumber: copy.gradeStatus === 'graded' ? copy.certificationNumber : '',
        budgetTracked: Boolean(copy.budgetTracked)
      });
    }
    return [...groups.values()];
  }

  function addOwned(card, variant, copies, countBudget, metadata) {
    const previousOwned = state.data.owned;
    const previousExpenses = state.data.expenses;
    const snapshotOwned = JSON.parse(JSON.stringify(previousOwned));
    const snapshotExpenses = JSON.parse(JSON.stringify(previousExpenses));
    const savedCopies = copies.map((copy) => {
      const paid = Number(copy.paid || 0);
      return {
        ...copy,
        id: copy.id || crypto.randomUUID(),
        budgetTracked: countBudget && copy.acquisitionMethod === 'purchased' && paid > 0
      };
    });
    const groups = groupOwnedCopies(card, variant, savedCopies, metadata);
    for (const group of groups) {
      const existing = state.data.owned.find((item) =>
        item.cardId === card.id && item.variant === variant &&
        item.condition === group.condition &&
        (item.language || card.lang || '') === group.language);
      if (existing) {
        existing.copies.push(...group.copies);
        for (const key of ['pokemon', 'cardName', 'setName', 'cardNumber', 'rarity', 'language', 'storageLocation', 'binderPage', 'note', 'tags']) {
          if (Array.isArray(group[key])) {
            if (group[key].length) existing[key] = group[key];
          } else if (group[key]) existing[key] = group[key];
        }
      } else state.data.owned.push(group);
    }
    for (const copy of savedCopies) {
      const paid = Number(copy.paid || 0);
      if (!copy.budgetTracked) continue;
      const purchasedAt = isoForLocalDate(copy.addedAt);
      state.data.expenses.push({
        id: crypto.randomUUID(),
        copyId: copy.id,
        amount: paid,
        note: `${metadata.cardName || card.name} · ${variant}`,
        date: purchasedAt,
        month: localMonth(new Date(purchasedAt))
      });
    }
    if (!saveData()) {
      state.data.owned = snapshotOwned;
      state.data.expenses = snapshotExpenses;
      return false;
    }
    return true;
  }

  function addWishlist(card, variant, targetPrice, priority) {
    const exists = state.data.wishlist.some((item) => item.cardId === card.id && item.variant === variant);
    if (exists) {
      showToast('That print and treatment are already on your wishlist.');
      return false;
    }
    const entry = {
      cardId: card.id,
      variant,
      verifiedVariant: Object.hasOwn(card.tcgplayer?.prices || {}, keyForVariant(variant)),
      addedAt: new Date().toISOString(),
      pokemon: cardPokemonId(card) || state.selectedPokemon,
      targetPrice,
      priority
    };
    state.data.wishlist.push(entry);
    if (!saveData()) {
      state.data.wishlist.pop();
      return false;
    }
    state.wishlistCards = [...state.wishlistCards.filter((item) => item.id !== card.id), card];
    cacheWishlistCards([card]);
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
    if (!state.data.wishlist.some((entry) => entry.cardId === cardId)) {
      state.wishlistCards = state.wishlistCards.filter((card) => card.id !== cardId);
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
    loadOwnedCards();
    showToast('Collection entry deleted.');
  }

  function validateBackupPayload(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
        (payload.version !== undefined && payload.version !== 1)) {
      throw new Error('This file is not a supported Aura Vault collection backup.');
    }
    for (const key of ['owned', 'wishlist', 'expenses']) {
      if (payload[key] !== undefined && !Array.isArray(payload[key])) {
        throw new Error(`Backup field "${key}" must be a list.`);
      }
    }
    if (!['owned', 'wishlist', 'expenses'].some((key) => Array.isArray(payload[key]))) {
      throw new Error('This backup contains no recognizable collection data.');
    }

    const imported = { ...payload };
    imported.owned = payload.owned || [];
    imported.wishlist = payload.wishlist || [];
    imported.expenses = payload.expenses || [];
    imported.favorites = payload.favorites === undefined ? [] : payload.favorites;
    if (!Array.isArray(imported.favorites) || imported.favorites.some((id) => typeof id !== 'string')) {
      throw new Error('Backup favorites must contain only card IDs.');
    }
    imported.owned.forEach((entry, index) => {
      if (!entry || typeof entry.cardId !== 'string' || !entry.cardId.trim() ||
          typeof entry.variant !== 'string' || !entry.variant.trim() ||
          typeof entry.condition !== 'string' || !entry.condition.trim() ||
          !Array.isArray(entry.copies) || !entry.copies.length ||
          (entry.note !== undefined && typeof entry.note !== 'string') ||
          (entry.tags !== undefined && (!Array.isArray(entry.tags) || entry.tags.some((tag) => typeof tag !== 'string'))) ||
          ['pokemon', 'cardName', 'setName', 'cardNumber', 'rarity', 'language', 'storageLocation', 'binderPage']
            .some((key) => entry[key] !== undefined && typeof entry[key] !== 'string')) {
        throw new Error(`Owned entry ${index + 1} is missing its card, variant, condition, or purchase records.`);
      }
      entry.copies.forEach((copy, copyIndex) => {
        if (!copy || typeof copy !== 'object' ||
            (copy.paid !== undefined && (typeof copy.paid !== 'number' || !Number.isFinite(copy.paid) || copy.paid < 0)) ||
            (copy.addedAt !== undefined && typeof copy.addedAt !== 'string') ||
            (copy.seller !== undefined && typeof copy.seller !== 'string') ||
            (copy.location !== undefined && typeof copy.location !== 'string') ||
            (copy.note !== undefined && typeof copy.note !== 'string') ||
            (copy.condition !== undefined && typeof copy.condition !== 'string') ||
            (copy.acquisitionMethod !== undefined && !['purchased', 'traded', 'gifted', 'pack-pull', 'other'].includes(copy.acquisitionMethod)) ||
            (copy.gradingStatus !== undefined && !['graded', 'ungraded'].includes(copy.gradingStatus)) ||
            (copy.budgetTracked !== undefined && typeof copy.budgetTracked !== 'boolean') ||
            ['gradingCompany', 'officialGrade', 'certificationNumber', 'storageLocation', 'binderPage']
              .some((key) => copy[key] !== undefined && typeof copy[key] !== 'string')) {
          throw new Error(`Purchase record ${copyIndex + 1} in owned entry ${index + 1} is invalid.`);
        }
      });
    });
    imported.wishlist.forEach((entry, index) => {
      if (!entry || typeof entry.cardId !== 'string' || !entry.cardId.trim() ||
          typeof entry.variant !== 'string' || !entry.variant.trim() ||
          (entry.targetPrice !== undefined && entry.targetPrice !== null &&
            (typeof entry.targetPrice !== 'number' || !Number.isFinite(entry.targetPrice) || entry.targetPrice < 0)) ||
          (entry.priority !== undefined && !['low', 'normal', 'high'].includes(entry.priority))) {
        throw new Error(`Wishlist entry ${index + 1} is invalid.`);
      }
    });
    imported.expenses.forEach((expense, index) => {
      if (!expense || typeof expense !== 'object' ||
          typeof expense.amount !== 'number' || !Number.isFinite(expense.amount) || expense.amount < 0 ||
          (expense.date !== undefined && typeof expense.date !== 'string')) {
        throw new Error(`Purchase expense ${index + 1} is invalid.`);
      }
    });
    if (payload.monthlyBudget !== undefined &&
        (typeof payload.monthlyBudget !== 'number' || !Number.isFinite(payload.monthlyBudget) || payload.monthlyBudget < 0)) {
      throw new Error('The backup monthly budget must be zero or greater.');
    }
    if (payload.tcgplayerLinks !== undefined &&
        (!payload.tcgplayerLinks || typeof payload.tcgplayerLinks !== 'object' || Array.isArray(payload.tcgplayerLinks))) {
      throw new Error('Backup TCGplayer links must be a card-ID map.');
    }
    for (const [cardId, url] of Object.entries(payload.tcgplayerLinks || {})) {
      if (!cardId || typeof url !== 'string' || !validTcgplayerProductUrl(url)) {
        throw new Error(`Backup contains an invalid TCGplayer link for card ${cardId || '(unknown)'}.`);
      }
    }
    imported.tcgplayerLinks = payload.tcgplayerLinks || {};
    delete imported.version;
    delete imported.exportedAt;
    return imported;
  }

  function openImportPreview(imported) {
    state.pendingImport = imported;
    const copyCount = imported.owned.reduce((sum, entry) => sum + entry.copies.length, 0);
    $('#import-preview-summary').innerHTML = `
      <div><strong>${imported.owned.length}</strong><span>collection entries</span></div>
      <div><strong>${copyCount}</strong><span>purchase records</span></div>
      <div><strong>${imported.wishlist.length}</strong><span>wishlist entries</span></div>
      <div><strong>${imported.expenses.length}</strong><span>budget purchases</span></div>
      <div><strong>${imported.favorites.length}</strong><span>featured favorites</span></div>
      <div><strong>${Number.isFinite(Number(imported.monthlyBudget)) ? formatMoney(Number(imported.monthlyBudget)) : 'Default'}</strong><span>monthly budget</span></div>
      <div><strong>${Object.keys(imported.tcgplayerLinks).length}</strong><span>saved product links</span></div>
      <p>${storedDataUnreadable
        ? 'The current local data could not be read. Merge is unavailable; a confirmed replace can restore this valid backup.'
        : `Current vault: ${state.data.owned.length} collection entries, ${state.data.wishlist.length} wishlist entries, and ${state.data.expenses.length} budget purchases. Merge is recommended to preserve it.`}</p>`;
    $('#import-merge-button').disabled = storedDataUnreadable;
    $('#import-replace-confirm').checked = false;
    $('#import-replace-button').disabled = true;
    $('#import-preview-dialog').showModal();
  }

  function mergeBackupIntoVault(imported) {
    const copySignature = (copy) => copy.id
      ? `id:${copy.id}`
      : `${copy.addedAt || ''}|${Number(copy.paid || 0)}|${copy.seller || ''}|${copy.location || ''}|${copy.binderPage || ''}|${copy.note || ''}`;
    for (const incoming of imported.owned) {
      let existing = state.data.owned.find((entry) => entry.cardId === incoming.cardId &&
        entry.variant === incoming.variant && entry.condition === incoming.condition &&
        (entry.language || 'English') === (incoming.language || 'English'));
      if (!existing) {
        existing = { ...incoming, copies: [] };
        state.data.owned.push(existing);
      }
      const knownCopies = new Set(existing.copies.map(copySignature));
      for (const copy of incoming.copies) {
        if (!knownCopies.has(copySignature(copy))) {
          existing.copies.push(copy);
          knownCopies.add(copySignature(copy));
        }
      }
      if (!existing.note && incoming.note) existing.note = incoming.note;
      if (!existing.storageLocation && incoming.storageLocation) existing.storageLocation = incoming.storageLocation;
      if (!existing.binderPage && incoming.binderPage) existing.binderPage = incoming.binderPage;
      if (!existing.tags?.length && incoming.tags?.length) existing.tags = incoming.tags;
    }
    for (const incoming of imported.wishlist) {
      const existing = state.data.wishlist.find((entry) =>
        entry.cardId === incoming.cardId && entry.variant === incoming.variant);
      if (!existing) state.data.wishlist.push(incoming);
      else {
        if (existing.targetPrice == null && incoming.targetPrice != null) existing.targetPrice = incoming.targetPrice;
        if (!existing.priority && incoming.priority) existing.priority = incoming.priority;
      }
    }
    const expenseKeys = new Set(state.data.expenses.map((item) =>
      item.id || `${item.date}|${item.amount}|${item.note}`));
    for (const incoming of imported.expenses) {
      const key = incoming.id || `${incoming.date}|${incoming.amount}|${incoming.note}`;
      if (!expenseKeys.has(key)) {
        state.data.expenses.push(incoming);
        expenseKeys.add(key);
      }
    }
    state.data.favorites = [...new Set([...state.data.favorites, ...imported.favorites])];
    if (state.data.monthlyBudget === undefined &&
        Number.isFinite(Number(imported.monthlyBudget)) && Number(imported.monthlyBudget) >= 0) {
      state.data.monthlyBudget = Number(imported.monthlyBudget);
    }
    state.data.tcgplayerLinks = { ...imported.tcgplayerLinks, ...state.data.tcgplayerLinks };
    for (const [key, value] of Object.entries(imported)) {
      if (!['owned', 'wishlist', 'expenses', 'favorites', 'monthlyBudget', 'tcgplayerLinks'].includes(key) &&
          state.data[key] === undefined) state.data[key] = value;
    }
  }

  function applyBackupImport(mode) {
    if (!state.pendingImport) return;
    if (mode === 'replace' && !$('#import-replace-confirm').checked) {
      showToast('Confirm that you want to replace the current vault before continuing.');
      return;
    }
    if (mode === 'replace' && !window.confirm('Replace all current collection, wishlist, spending, and settings data with this backup? Export your current vault first if you may need it later.')) return;
    const previous = JSON.parse(JSON.stringify(state.data));
    const previousUnreadable = storedDataUnreadable;
    const imported = state.pendingImport;
    if (mode === 'replace') {
      state.data = {
        ...imported,
        owned: imported.owned,
        wishlist: imported.wishlist,
        expenses: imported.expenses,
        monthlyBudget: Number.isFinite(Number(imported.monthlyBudget))
          ? Number(imported.monthlyBudget) : DEFAULT_MONTHLY_BUDGET,
        favorites: imported.favorites,
        tcgplayerLinks: imported.tcgplayerLinks
      };
    } else {
      mergeBackupIntoVault(imported);
    }
    if (mode === 'replace') storedDataUnreadable = false;
    if (!saveData()) {
      state.data = previous;
      storedDataUnreadable = previousUnreadable;
      return;
    }
    state.pendingImport = null;
    $('#import-preview-dialog').close();
    renderCatalog();
    loadWishlistCards();
    loadOwnedCards();
    showToast(mode === 'replace' ? 'Backup restored. Your vault has been replaced.' : 'Backup merged without removing your existing records.');
  }

  async function importDataFile(file) {
    if (!file) return;
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('Backup files must be 20 MB or smaller.');
      const imported = JSON.parse(await file.text());
      openImportPreview(validateBackupPayload(imported));
    } catch (error) {
      console.error('Could not import collection backup:', error);
      showToast(error instanceof SyntaxError ? 'Could not read backup: invalid JSON.' : error.message || 'Could not import this backup.');
    } finally {
      $('#import-file').value = '';
    }
  }

  function exportData() {
    if (storedDataUnreadable) {
      showToast('Saved data could not be read. Export was stopped to avoid creating an empty backup.');
      return;
    }
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
    if (state.savingCard) return;
    state.savingCard = true;
    $('#dialog-submit').disabled = true;
    $('#dialog-add-another').disabled = true;
    try {
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
      const metadata = inventoryMetadata();
      if (!metadata.cardName) {
        $('#entry-card-name').focus();
        showToast('Enter the card name before saving.');
        return;
      }
      const copies = copyRowsFromForm();
      if (!copies.length || (action === 'owned' && (copies.length > 25 ||
          (!Number.isInteger(Number($('#purchase-quantity').value)) ||
           Number($('#purchase-quantity').value) !== copies.length)))) {
        showToast('Choose a quantity from 1 to 25.');
        return;
      }
      for (const [index, copy] of copies.entries()) {
        const paid = copy.paid === '' ? 0 : Number(copy.paid);
        if (!Number.isFinite(paid) || paid < 0) {
          showToast(`Enter a valid price for copy ${index + 1}.`);
          return;
        }
        if (!/^\d{4}-\d{2}-\d{2}$/.test(copy.addedAt) ||
            !Number.isFinite(new Date(`${copy.addedAt}T12:00:00`).getTime())) {
          showToast(`Choose a valid acquisition date for copy ${index + 1}.`);
          return;
        }
        if (copy.gradeStatus === 'graded' && (!copy.gradingCompany || !copy.officialGrade)) {
          showToast(`Enter the grading company and official grade for copy ${index + 1}, or mark it ungraded.`);
          return;
        }
        copy.paid = paid;
      }
      if (action === 'owned') {
        changed = addOwned(card, variant, copies, $('#budget-check').checked, metadata);
      } else {
        const index = state.editingGroupIndex;
        const existing = Number.isInteger(index) ? state.data.owned[index] : null;
        if (!existing) {
          showToast('That collection entry could not be found.');
          return;
        }
        const previousOwned = JSON.parse(JSON.stringify(state.data.owned));
        const previousExpenses = JSON.parse(JSON.stringify(state.data.expenses));
        const updatedGroups = groupOwnedCopies(card, variant, copies, metadata, existing);
        for (const copy of updatedGroups.flatMap((group) => group.copies)) {
          if (!copy.budgetTracked) continue;
          const expenseIndex = state.data.expenses.findIndex((expense) => expense.copyId === copy.id);
          if (copy.acquisitionMethod !== 'purchased' || copy.paid <= 0) {
            if (expenseIndex >= 0) state.data.expenses.splice(expenseIndex, 1);
            copy.budgetTracked = false;
          } else if (expenseIndex >= 0) {
            const purchasedAt = copy.addedAt;
            state.data.expenses[expenseIndex] = {
              ...state.data.expenses[expenseIndex],
              amount: copy.paid,
              note: `${metadata.cardName || card.name} · ${variant}`,
              date: purchasedAt,
              month: localMonth(new Date(purchasedAt))
            };
          }
        }
        state.data.owned.splice(index, 1, ...updatedGroups);
        changed = saveData();
        if (!changed) {
          state.data.owned = previousOwned;
          state.data.expenses = previousExpenses;
        }
      }
    } else if (action === 'wishlist-edit') {
      const index = state.editingWishlistIndex;
      const existing = Number.isInteger(index) ? state.data.wishlist[index] : null;
      if (!existing) {
        showToast('That wishlist entry could not be found.');
        return;
      }
      const targetValue = $('#target-price-input').value.trim();
      const targetPrice = targetValue === '' ? null : Number(targetValue);
      if (targetPrice !== null && (!Number.isFinite(targetPrice) || targetPrice < 0)) {
        showToast('Enter a valid target price or leave it blank.');
        return;
      }
      const duplicate = state.data.wishlist.some((item, entryIndex) => entryIndex !== index &&
        item.cardId === card.id && item.variant === variant);
      if (duplicate) {
        showToast('That card and treatment are already on your wishlist.');
        return;
      }
      const previous = { ...existing };
      existing.variant = variant;
      existing.verifiedVariant = Object.hasOwn(card.tcgplayer?.prices || {}, keyForVariant(variant));
      existing.targetPrice = targetPrice;
      existing.priority = $('#wishlist-priority').value;
      existing.pokemon = existing.pokemon || state.selectedPokemon;
      changed = saveData();
      if (!changed) state.data.wishlist[index] = previous;
    } else {
      const targetValue = $('#target-price-input').value.trim();
      const targetPrice = targetValue === '' ? null : Number(targetValue);
      if (targetPrice !== null && (!Number.isFinite(targetPrice) || targetPrice < 0)) {
        showToast('Enter a valid target price or leave it blank.');
        return;
      }
      changed = addWishlist(card, variant, targetPrice, $('#wishlist-priority').value);
    }
    if (changed) {
      const addAnother = event.submitter?.id === 'dialog-add-another';
      $('#card-dialog').close();
      renderCatalog();
      if (action === 'owned' || action === 'edit') loadOwnedCards();
      if (action === 'wishlist' || action === 'wishlist-edit') loadWishlistCards();
      if (addAnother) openCardDialog(card, 'owned');
      showToast(addAnother
        ? 'Saved. The add form is ready for another card.'
        : action === 'owned' ? 'Card added to your collection.'
          : action === 'edit' ? 'Collection entry updated.'
            : action === 'wishlist-edit' ? 'Wishlist target updated.' : 'Card added to your wishlist.');
    }
    } finally {
      state.savingCard = false;
      if ($('#card-dialog').open) {
        $('#dialog-submit').disabled = false;
        $('#dialog-add-another').disabled = false;
      }
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
    $('#pokemon-filter').addEventListener('change', () => {
      state.query = '';
      $('#search-input').value = '';
      $('#collection-search').value = '';
      state.filters.rarity = '';
      state.filters.language = '';
      state.filters.set = '';
      state.filters.type = '';
      state.filters.pokemon = '';
      state.filters.condition = '';
      loadCatalog();
    });
    $('#set-filter').addEventListener('change', (event) => { state.filters.set = event.target.value; renderCatalog(); });
    $('#rarity-filter').addEventListener('change', (event) => { state.filters.rarity = event.target.value; renderCatalog(); });
    $('#language-filter').addEventListener('change', (event) => { state.filters.language = event.target.value; renderCatalog(); });
    $('#type-filter').addEventListener('change', (event) => { state.filters.type = event.target.value; renderCatalog(); });
    $('#card-pokemon-filter').addEventListener('change', (event) => { state.filters.pokemon = event.target.value; renderCatalog(); });
    $('#condition-filter').addEventListener('change', (event) => { state.filters.condition = event.target.value; renderCatalog(); });
    $('#ownership-filter').addEventListener('change', (event) => { state.filters.ownership = event.target.value; renderCatalog(); });
    $('#favorite-filter').addEventListener('change', (event) => { state.filters.favorites = event.target.value; renderCatalog(); });
    $('#wishlist-filter').addEventListener('change', (event) => { state.filters.wishlist = event.target.value; renderCatalog(); });
    $('#clear-filters-button').addEventListener('click', clearFilters);
    $('#refresh-button').addEventListener('click', loadCatalog);
    window.addEventListener('online', () => {
      if (!state.loading) {
        window.setTimeout(() => {
          if (navigator.onLine && !state.loading) loadCatalog();
        }, 500);
      }
    });
    $('#browse-button').addEventListener('click', openCardPicker);
    $('#collection-add-button').addEventListener('click', openCardPicker);
    $('#hero-explore-button').addEventListener('click', () => navigateTo('collection'));
    $('#hero-all-cards-button').addEventListener('click', () => {
      setView('all');
      navigateTo('collection');
    });
    $('#hero-wishlist-button').addEventListener('click', () => navigateTo('wishlist'));
    $('#export-button').addEventListener('click', exportData);
    $('#import-button').addEventListener('click', () => $('#import-file').click());
    $('#import-file').addEventListener('change', (event) => importDataFile(event.target.files[0]));
    $('#import-replace-confirm').addEventListener('change', (event) => {
      $('#import-replace-button').disabled = !event.target.checked;
    });
    $('#import-merge-button').addEventListener('click', () => applyBackupImport('merge'));
    $('#import-replace-button').addEventListener('click', () => applyBackupImport('replace'));
    $('#import-preview-dialog').addEventListener('close', () => {
      state.pendingImport = null;
      $('#import-file').value = '';
    });
    $('#mobile-more-button').addEventListener('click', exportData);
    $('#scan-card-button').addEventListener('click', openScanner);
    $('#scanner-capture').addEventListener('click', () => captureScanImage().catch((error) => {
      console.error('Could not capture scanner image:', error);
      $('#scanner-status').textContent = error.message || 'Could not capture the card image.';
    }));
    $('#scanner-retake').addEventListener('click', () => {
      state.scanImage = null;
      state.scanOriginalDataUrl = '';
      $('#scanner-image-editor').hidden = true;
      $('#scanner-results').replaceChildren();
      if (state.cameraStream?.active) {
        $('#scanner-camera-wrap').hidden = false;
        $('#scanner-video').hidden = false;
        $('#scanner-capture').disabled = false;
        $('#scanner-status').textContent = 'Center the card inside the guides and capture again.';
      } else {
        $('#scanner-camera-wrap').hidden = true;
        $('#scanner-status').textContent = 'Upload another image or search the catalog manually.';
      }
    });
    $('#scanner-torch').addEventListener('click', toggleScannerTorch);
    $('#scanner-upload').addEventListener('change', (event) => {
      handleScanUpload(event.target.files[0]);
      event.target.value = '';
    });
    $('#scanner-rotate').addEventListener('click', () => {
      state.scanRotation = (state.scanRotation + 90) % 360;
      try {
        const canvas = updateScanPreview();
        $('#scanner-quality').textContent = scanImageQuality(canvas);
      } catch (error) {
        $('#scanner-status').textContent = error.message;
      }
    });
    $('#scanner-crop').addEventListener('input', (event) => {
      state.scanCropPercent = Number(event.target.value);
      $('#scanner-crop-value').value = `${state.scanCropPercent}%`;
      try {
        const canvas = updateScanPreview();
        $('#scanner-quality').textContent = scanImageQuality(canvas);
      } catch (error) {
        $('#scanner-status').textContent = error.message;
      }
    });
    $('#scanner-identify').addEventListener('click', identifyCapturedCard);
    $('#scanner-search-button').addEventListener('click', () =>
      queryScanCatalog($('#scanner-search').value, $('#scanner-search').value, null, null, true));
    $('#scanner-search').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        queryScanCatalog($('#scanner-search').value, $('#scanner-search').value, null, null, true);
      }
    });
    $('#scanner-queue-save').addEventListener('click', saveScanQueue);
    $('#scanner-dialog').addEventListener('close', stopScannerCamera);
    $('#scanner-results').addEventListener('click', (event) => {
      const button = event.target.closest('[data-scan-card-id]');
      if (button) addScanCandidate(button.dataset.scanCardId);
    });
    $('#scanner-queue').addEventListener('input', (event) => {
      const field = event.target.closest('[data-queue-field]');
      const row = event.target.closest('[data-queue-id]');
      const entry = state.scanQueue.find((item) => item.id === row?.dataset.queueId);
      if (field && entry) entry[field.dataset.queueField] = field.value;
    });
    $('#scanner-queue').addEventListener('change', (event) => {
      const field = event.target.closest('[data-queue-field]');
      const row = event.target.closest('[data-queue-id]');
      const entry = state.scanQueue.find((item) => item.id === row?.dataset.queueId);
      if (field && entry) {
        entry[field.dataset.queueField] = field.value;
        if (field.dataset.queueField === 'variant') {
          row.querySelector('.scanner-queue-custom-variant').hidden = field.value !== '__custom__';
        }
        if (['condition', 'language', 'variant', 'customVariant'].includes(field.dataset.queueField)) {
          row.querySelector('.scanner-duplicate-warning-slot').innerHTML = scannerDuplicateWarning(entry);
        }
      }
    });
    $('#scanner-queue').addEventListener('click', (event) => {
      const button = event.target.closest('[data-queue-action]');
      if (!button) return;
      const index = state.scanQueue.findIndex((item) => item.id === button.dataset.queueId);
      if (index < 0) return;
      if (button.dataset.queueAction === 'remove') {
        state.scanQueue.splice(index, 1);
        renderScanQueue();
        return;
      }
      if (button.dataset.queueAction === 'rescan') {
        state.scanRescanQueueId = state.scanQueue[index].id;
        state.scanImage = null;
        state.scanOriginalDataUrl = '';
        $('#scanner-image-editor').hidden = true;
        $('#scanner-results').replaceChildren();
        if (state.cameraStream?.active) {
          $('#scanner-camera-wrap').hidden = false;
          $('#scanner-video').hidden = false;
          $('#scanner-capture').disabled = false;
          $('#scanner-status').textContent = 'Capture a replacement image and confirm a different candidate to replace this queue entry.';
        } else {
          $('#scanner-camera-wrap').hidden = true;
          $('#scanner-status').textContent = 'Upload a replacement image. The existing queued card remains until you choose a new match.';
          $('#scanner-upload').click();
        }
      }
    });
    $('#card-picker-search').addEventListener('input', renderCardPicker);
    $('#card-picker-results').addEventListener('click', (event) => {
      const option = event.target.closest('[data-picker-card-id]');
      const card = option ? state.cards.find((entry) => entry.id === option.dataset.pickerCardId) : null;
      if (!card) return;
      $('#card-picker-dialog').close();
      openCardDialog(card, 'owned');
    });
    $('#empty-action').addEventListener('click', () => {
      if (state.view === 'wishlist' || state.view === 'owned') setView('all');
      else if (state.view !== 'all' && state.cards.length) setView('all');
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
      if (button.dataset.action === 'wishlist-edit') openCardDialog(card, 'wishlist-edit', Number(button.dataset.wishlistIndex));
    });
    for (const grid of ['#recent-grid', '#favorites-grid']) {
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
      if (button.dataset.action === 'detail-price') {
        $('#detail-dialog').close();
        openPricesDialog(card);
      } else if (button.dataset.action === 'detail-add') {
        $('#detail-dialog').close();
        openCardDialog(card, 'owned');
      } else if (button.dataset.action === 'detail-wishlist') {
        $('#detail-dialog').close();
        if (cardWished(card.id)) removeWishlist(card.id);
        else openCardDialog(card, 'wishlist');
      } else if (button.dataset.action === 'detail-wishlist-edit') {
        $('#detail-dialog').close();
        const index = state.data.wishlist.findIndex((item) => item.cardId === card.id);
        if (index >= 0) openCardDialog(card, 'wishlist-edit', index);
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
      updateDuplicateWarning();
      if (isCustom) $('#custom-variant').focus();
    });
    $('#custom-variant').addEventListener('input', () => {
      updateDialogPrice();
      updateDuplicateWarning();
    });
    $('#purchase-quantity').addEventListener('change', () => {
      const count = Number($('#purchase-quantity').value);
      if (!Number.isInteger(count) || count < 1 || count > 25) return;
      const existing = copyRowsFromForm();
      const first = existing[0] || {};
      renderCopyRows(existing, count, first);
      updateDuplicateWarning();
    });
    $('#copy-record-list').addEventListener('input', () => {
      updateInventorySummary();
      updateDuplicateWarning();
    });
    $('#copy-record-list').addEventListener('change', (event) => {
      const row = event.target.closest('.copy-record-row');
      if (event.target.matches('[data-copy-grade-status]') && row) {
        row.querySelector('.copy-grade-fields').hidden = event.target.value !== 'graded';
      }
      updateInventorySummary();
      updateDuplicateWarning();
    });
    $('#card-form').addEventListener('input', (event) => {
      if (event.target.matches('#entry-card-name, #entry-set-name, #entry-card-number, #entry-rarity, #entry-language, #entry-pokemon, #entry-storage, #entry-slot, #entry-tags, #notes-input')) {
        updateInventorySummary();
      }
      if (event.target.matches('#entry-language')) updateDuplicateWarning();
    });
    $('#dialog-cancel').addEventListener('click', () => $('#card-dialog').close());
    $('#prices-variant').addEventListener('change', updatePriceLinks);
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
    $('#adjust-budget-button').addEventListener('click', () => {
      $('#budget-amount').value = String(state.data.monthlyBudget);
      $('#budget-dialog').showModal();
    });
    $('#budget-form').addEventListener('submit', (event) => {
      event.preventDefault();
      const amount = Number($('#budget-amount').value);
      if (!Number.isFinite(amount) || amount < 0) {
        showToast('Enter a valid monthly budget of zero or more.');
        return;
      }
      const previous = state.data.monthlyBudget;
      state.data.monthlyBudget = amount;
      if (!saveData()) {
        state.data.monthlyBudget = previous;
        return;
      }
      $('#budget-dialog').close();
      renderCatalog();
      showToast('Monthly budget updated.');
    });
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
      if (!(image instanceof HTMLImageElement) ||
          (!image.classList.contains('card-art') && !image.classList.contains('detail-art') &&
           !image.closest('.inventory-preview-art') && !image.closest('.card-picker-art'))) return;
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
  loadWishlistCards();
  loadOwnedCards();
  loadPokemonSpecies().then(() => {
    renderCatalog();
    loadCatalog();
  });
})();
