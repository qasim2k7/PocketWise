/* =========================================================
   PocketWise — script.js
   All application logic. Wrapped in an IIFE so nothing leaks
   into the global scope (defense against other scripts on the
   page, and against accidental collisions).

   SECURITY PRINCIPLES USED THROUGHOUT THIS FILE
   ---------------------------------------------
   1. Never use innerHTML with user-supplied data. All dynamic
      text is inserted with textContent or built via
      document.createElement, so a category name or description
      like  <img src=x onerror=alert(1)>  can NEVER execute as
      HTML/JS — it just displays as plain text.
   2. Every value coming from a <form> or from localStorage is
      treated as UNTRUSTED input and re-validated before use,
      even though "the attacker" is normally just the same user
      poking at devtools — corrupted/malicious data must never
      crash the app or run arbitrary code.
   3. Numbers are parsed with Number(), then checked with
      Number.isFinite() and range limits — never trusted blindly,
      never passed through eval/Function.
   4. Strings are trimmed and length-capped before storage, to
      stop localStorage bloat and to keep the UI predictable.
   5. IDs use crypto.randomUUID() (with a safe fallback) instead
      of Date.now(), so IDs can't collide or be guessed/predicted.
   6. localStorage reads are wrapped in try/catch and schema-
      validated; any corrupted or tampered data is discarded and
      replaced with safe defaults rather than trusted as-is.
   7. Destructive actions (Clear All, Delete) always require
      confirmation.
   8. No eval(), no Function(), no dynamically built <script>
      tags, no inline event handlers (addEventListener only).
   ========================================================= */

(function () {
    "use strict";

    /* =====================================================
       CONSTANTS
       ===================================================== */

    const STORAGE_KEYS = {
        transactions: "pocketwise_transactions",
        categories: "pocketwise_categories",
        budget: "pocketwise_budget",
        quickAdd: "pocketwise_quickadd"
    };

    const LIMITS = {
        descriptionMaxLength: 60,
        categoryNameMaxLength: 24,
        emojiMaxLength: 8,       // enough for multi-codepoint emoji (e.g. flags, ZWJ sequences)
        maxAmount: 10000000,     // Rs. 10,000,000 — sane upper bound, prevents overflow/UI break
        minAmount: 1,
        maxCategories: 40
    };

    const DEFAULT_CATEGORIES = [
        { id: "grocery", emoji: "🛒", name: "Grocery" },
        { id: "lunch", emoji: "🍔", name: "Lunch" },
        { id: "dinner", emoji: "🍽️", name: "Dinner" },
        { id: "laundry", emoji: "🧺", name: "Laundry" },
        { id: "petrol", emoji: "⛽", name: "Petrol" },
        { id: "hostel-rent", emoji: "🏠", name: "Hostel Rent" },
        { id: "shopping", emoji: "🛍️", name: "Shopping" },
        { id: "bike-repair", emoji: "🔧", name: "Bike Repair" },
        { id: "gym", emoji: "💪", name: "Gym" },
        { id: "tea", emoji: "☕", name: "Tea" },
        { id: "printout", emoji: "🖨️", name: "Printout" },
        { id: "rickshaw", emoji: "🛺", name: "Rickshaw" }
    ];

    const DEFAULT_BUDGET = {
        monthlyBudget: 0,
        lowBalanceThreshold: 1000,
        dailySafeSpendOverride: null // null = auto-calculate from budget & days left
    };


    /* =====================================================
       UTILITIES
       ===================================================== */

    /** Generate a hard-to-guess unique ID. Falls back safely if
     *  crypto.randomUUID isn't available in this environment. */
    function generateId() {
        if (window.crypto && typeof window.crypto.randomUUID === "function") {
            return window.crypto.randomUUID();
        }
        // Fallback: timestamp + random suffix, still practically unique
        return "id-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 10);
    }

    /** Strip anything that isn't plain, safe text. We never rely on
     *  this for DOM insertion safety (we use textContent for that),
     *  but stored data should also not contain HTML/script fragments
     *  in case it's ever exported, printed, or rendered elsewhere. */
    function sanitizeText(value, maxLength) {
        if (typeof value !== "string") return "";
        // Strip HTML tags entirely
        let clean = value.replace(/<[^>]*>/g, "");
        // Strip control characters
        clean = clean.replace(/[\u0000-\u001F\u007F]/g, "");
        clean = clean.trim();
        if (clean.length > maxLength) {
            clean = clean.slice(0, maxLength);
        }
        return clean;
    }

    /** Turn a category name into a safe, predictable slug id.
     *  Only lowercase letters, numbers, and hyphens survive. */
    function slugify(name) {
        return name
            .toLowerCase()
            .trim()
            .replace(/[^a-z0-9\s-]/g, "")
            .replace(/\s+/g, "-")
            .replace(/-+/g, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 30);
    }

    /** Strict numeric validation. Returns null if invalid. */
    function parseSafeAmount(value) {
        const num = Number(value);
        if (!Number.isFinite(num)) return null;
        if (num < LIMITS.minAmount || num > LIMITS.maxAmount) return null;
        // Round to 2 decimal places to avoid floating point weirdness
        return Math.round(num * 100) / 100;
    }

    /** Validate a date string is a real, reasonable calendar date
     *  (not a malformed string, not absurdly far in the past/future). */
    function parseSafeDate(value) {
        if (typeof value !== "string") return null;
        const date = new Date(value + "T00:00:00");
        if (isNaN(date.getTime())) return null;

        const now = new Date();
        const minDate = new Date(now.getFullYear() - 10, 0, 1);
        const maxDate = new Date(now.getFullYear() + 1, 11, 31);
        if (date < minDate || date > maxDate) return null;

        return value; // keep original ISO yyyy-mm-dd string
    }

    /** Format a number as Rs. currency for display. */
    function formatCurrency(amount) {
        const safe = Number.isFinite(amount) ? amount : 0;
        return "Rs. " + safe.toLocaleString("en-PK", { maximumFractionDigits: 0 });
    }

    /** Format an ISO date (yyyy-mm-dd) as "20 Sep". */
    function formatShortDate(isoDate) {
        const date = new Date(isoDate + "T00:00:00");
        if (isNaN(date.getTime())) return isoDate;
        return date.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
    }

    /** Safe localStorage read with schema validation + fallback. */
    function loadFromStorage(key, validator, fallback) {
        try {
            const raw = window.localStorage.getItem(key);
            if (!raw) return fallback;
            const parsed = JSON.parse(raw);
            if (!validator(parsed)) return fallback;
            return parsed;
        } catch (err) {
            // Corrupted JSON or storage access blocked — fail safe, never crash
            console.warn("PocketWise: could not read " + key + ", using defaults.", err);
            return fallback;
        }
    }

    /** Safe localStorage write. Never throws to the caller. */
    function saveToStorage(key, value) {
        try {
            window.localStorage.setItem(key, JSON.stringify(value));
            return true;
        } catch (err) {
            console.warn("PocketWise: could not save " + key + ".", err);
            return false;
        }
    }

    /** Debounce helper — limits how often a function can fire
     *  (protects against excessive re-renders from fast typing,
     *  and is generally good hygiene for input handlers). */
    function debounce(fn, delay) {
        let timer = null;
        return function (...args) {
            clearTimeout(timer);
            timer = setTimeout(() => fn.apply(this, args), delay);
        };
    }


    /* =====================================================
       VALIDATION SCHEMAS
       (used when loading from localStorage, so tampered or
       corrupted data can never crash the app or inject bad
       values into calculations)
       ===================================================== */

    function isValidTransaction(t) {
        return (
            t && typeof t === "object" &&
            typeof t.id === "string" &&
            (t.type === "expense" || t.type === "pocket-money") &&
            typeof t.amount === "number" && Number.isFinite(t.amount) &&
            t.amount >= LIMITS.minAmount && t.amount <= LIMITS.maxAmount &&
            typeof t.category === "string" &&
            typeof t.description === "string" &&
            typeof t.date === "string" &&
            !isNaN(new Date(t.date + "T00:00:00").getTime())
        );
    }

    function isValidTransactionsArray(arr) {
        return Array.isArray(arr) && arr.every(isValidTransaction);
    }

    function isValidCategory(c) {
        return (
            c && typeof c === "object" &&
            typeof c.id === "string" && c.id.length > 0 && c.id.length <= 30 &&
            typeof c.name === "string" && c.name.length > 0 &&
            typeof c.emoji === "string"
        );
    }

    function isValidCategoriesArray(arr) {
        return Array.isArray(arr) && arr.length > 0 && arr.every(isValidCategory);
    }

    function isValidBudget(b) {
        const overrideOk =
            b.dailySafeSpendOverride === null ||
            b.dailySafeSpendOverride === undefined ||
            (typeof b.dailySafeSpendOverride === "number" &&
             Number.isFinite(b.dailySafeSpendOverride) &&
             b.dailySafeSpendOverride >= 0);

        return (
            b && typeof b === "object" &&
            typeof b.monthlyBudget === "number" && Number.isFinite(b.monthlyBudget) && b.monthlyBudget >= 0 &&
            typeof b.lowBalanceThreshold === "number" && Number.isFinite(b.lowBalanceThreshold) && b.lowBalanceThreshold >= 0 &&
            overrideOk
        );
    }


    /* =====================================================
       STATE
       ===================================================== */

    let transactions = loadFromStorage(STORAGE_KEYS.transactions, isValidTransactionsArray, []);
    let categories = loadFromStorage(STORAGE_KEYS.categories, isValidCategoriesArray, DEFAULT_CATEGORIES.slice());
    let budget = loadFromStorage(STORAGE_KEYS.budget, isValidBudget, { ...DEFAULT_BUDGET });

    // Holds the most recently deleted transaction for 5 seconds,
    // so the Undo toast can restore it. Cleared automatically.
    let lastDeleted = null;
    let undoTimer = null;


    /* =====================================================
       DOM REFERENCES
       (queried once; if an element is missing, guarded checks
       below prevent crashes rather than throwing)
       ===================================================== */

    const el = {
        balance: document.getElementById("balance"),
        totalExpenses: document.getElementById("total-expenses"),
        daysLeft: document.getElementById("days-left"),
        dailySafeSpend: document.getElementById("daily-safe-spend"),

        lowBalanceBanner: document.getElementById("low-balance-banner"),
        lowBalanceAmount: document.getElementById("low-balance-amount"),

        circlePercentage: document.getElementById("circle-percentage"),
        circleLabel: document.getElementById("circle-label"),
        spendingCircle: document.getElementById("spending-circle"),
        circleStatSpent: document.getElementById("circle-stat-spent"),
        circleStatBudget: document.getElementById("circle-stat-budget"),
        circleStatRemaining: document.getElementById("circle-stat-remaining"),

        form: document.getElementById("transaction-form"),
        typeInput: document.getElementById("type"),
        amountInput: document.getElementById("amount"),
        categoryInput: document.getElementById("category"),
        descriptionInput: document.getElementById("description"),
        dateInput: document.getElementById("date"),

        quickAddButtons: document.querySelectorAll(".quick-add-btn[data-category]"),
        editQuickAddBtn: document.getElementById("edit-quick-add"),

        categoryList: document.getElementById("category-list"),
        newCategoryInput: document.getElementById("new-category"),
        addCategoryBtn: document.getElementById("add-category"),
        selectedEmojiValue: document.getElementById("selected-emoji-value"),
        selectedEmojiPreview: document.getElementById("selected-emoji-preview"),
        filterCategorySelect: document.getElementById("filter-category"),

        monthlyBudgetInput: document.getElementById("monthly-budget"),
        lowBalanceThresholdInput: document.getElementById("low-balance-threshold"),
        dailySafeSpendOverrideInput: document.getElementById("daily-safe-spend-override"),
        saveBudgetBtn: document.getElementById("save-budget"),

        clearAllBtn: document.getElementById("clear-all"),
        searchInput: document.getElementById("search-transactions"),
        filterTypeSelect: document.getElementById("filter-type"),
        sortSelect: document.getElementById("sort-transactions"),
        transactionLog: document.getElementById("transaction-log"),

        pageFirstBtn: document.getElementById("page-first"),
        pagePrevBtn: document.getElementById("page-prev"),
        pageNextBtn: document.getElementById("page-next"),
        pageLastBtn: document.getElementById("page-last"),
        pageIndicator: document.getElementById("page-indicator"),

        undoToast: document.getElementById("undo-toast"),
        undoToastMessage: document.getElementById("undo-toast-message"),
        undoDeleteBtn: document.getElementById("undo-delete-btn"),

        confirmOverlay: document.getElementById("confirm-modal-overlay"),
        confirmTitle: document.getElementById("confirm-modal-title"),
        confirmMessage: document.getElementById("confirm-modal-message"),
        confirmCancelBtn: document.getElementById("confirm-modal-cancel"),
        confirmConfirmBtn: document.getElementById("confirm-modal-confirm"),

        quickAddEditOverlay: document.getElementById("quick-add-edit-overlay"),
        quickAddEditCancelBtn: document.getElementById("quick-add-edit-cancel"),
        quickAddEditSaveBtn: document.getElementById("quick-add-edit-save")
    };


    /* =====================================================
       DERIVED DATA HELPERS
       ===================================================== */

    function getCategoryById(id) {
        return categories.find(c => c.id === id) || null;
    }

    function getTotalPocketMoney() {
        return transactions
            .filter(t => t.type === "pocket-money")
            .reduce((sum, t) => sum + t.amount, 0);
    }

    function getTotalExpenses() {
        return transactions
            .filter(t => t.type === "expense")
            .reduce((sum, t) => sum + t.amount, 0);
    }

    /** Total Balance = remaining budget for the month.
     *  Pocket Money entries are logged for record-keeping, but the
     *  balance itself is driven by the Monthly Budget you set,
     *  minus what you've actually spent this month. */
    function getBalance() {
        return budget.monthlyBudget - getCurrentMonthExpenses();
    }

    function getCurrentMonthExpenses() {
        const now = new Date();
        const y = now.getFullYear();
        const m = now.getMonth();
        return transactions
            .filter(t => {
                if (t.type !== "expense") return false;
                const d = new Date(t.date + "T00:00:00");
                return d.getFullYear() === y && d.getMonth() === m;
            })
            .reduce((sum, t) => sum + t.amount, 0);
    }

    function getDaysLeftInMonth() {
        const now = new Date();
        const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
        return Math.max(lastDay - now.getDate(), 0) + 1; // include today
    }


    /* =====================================================
       RENDERING
       ===================================================== */

    function renderDashboard() {
        const balance = getBalance();
        const totalExpenses = getTotalExpenses();
        const monthExpenses = getCurrentMonthExpenses();
        const daysLeft = getDaysLeftInMonth();
        const remainingBudget = Math.max(budget.monthlyBudget - monthExpenses, 0);
        const autoDailySafeSpend = daysLeft > 0 ? remainingBudget / daysLeft : remainingBudget;

        // If the user set a manual daily safe-spend limit, that takes
        // priority over the auto-calculated one.
        const hasOverride = typeof budget.dailySafeSpendOverride === "number";
        const dailySafeSpend = hasOverride ? budget.dailySafeSpendOverride : autoDailySafeSpend;

        if (el.balance) el.balance.textContent = formatCurrency(balance);
        if (el.totalExpenses) el.totalExpenses.textContent = formatCurrency(totalExpenses);
        if (el.daysLeft) el.daysLeft.textContent = daysLeft + (daysLeft === 1 ? " day" : " days");
        if (el.dailySafeSpend) el.dailySafeSpend.textContent = formatCurrency(dailySafeSpend);

        // Low balance card + banner styling
        const balanceCard = el.balance ? el.balance.closest(".summary-card") : null;
        const isLow = balance < budget.lowBalanceThreshold;

        if (balanceCard) balanceCard.classList.toggle("low-balance", isLow);

        if (el.lowBalanceBanner) {
            el.lowBalanceBanner.classList.toggle("hidden", !isLow);
        }
        if (el.lowBalanceAmount) {
            el.lowBalanceAmount.textContent = formatCurrency(balance);
        }
    }

    function renderCircle() {
        const monthExpenses = getCurrentMonthExpenses();
        const monthlyBudget = budget.monthlyBudget;

        let percentSpent = 0;
        if (monthlyBudget > 0) {
            percentSpent = Math.min((monthExpenses / monthlyBudget) * 100, 100);
        } else if (monthExpenses > 0) {
            percentSpent = 100; // spending with no budget set = fully "at risk"
        }
        const percentSaving = 100 - percentSpent;
        const remaining = Math.max(monthlyBudget - monthExpenses, 0);

        if (el.spendingCircle) {
            el.spendingCircle.style.background =
                `conic-gradient(var(--color-danger) 0% ${percentSpent}%, var(--color-lavender) ${percentSpent}% 100%)`;
        }
        if (el.circlePercentage) {
            el.circlePercentage.textContent = Math.round(percentSaving) + "%";
        }
        if (el.circleLabel) {
            el.circleLabel.textContent = "Saving";
        }
        if (el.circleStatSpent) el.circleStatSpent.textContent = formatCurrency(monthExpenses);
        if (el.circleStatBudget) el.circleStatBudget.textContent = formatCurrency(monthlyBudget);
        if (el.circleStatRemaining) el.circleStatRemaining.textContent = formatCurrency(remaining);
    }

    /** Rebuild the category <select> elements and the manager list
     *  from the current `categories` state. Uses textContent /
     *  createElement only — no innerHTML with user data. */
    function renderCategoryOptions() {
        const selects = [el.categoryInput, el.filterCategorySelect].filter(Boolean);

        selects.forEach(select => {
            const isFilter = select === el.filterCategorySelect;
            const previousValue = select.value;

            select.innerHTML = ""; // safe: we only insert static/trusted <option> nodes below

            if (isFilter) {
                const allOption = document.createElement("option");
                allOption.value = "all";
                allOption.textContent = "All Categories";
                select.appendChild(allOption);
            }

            categories.forEach(cat => {
                const option = document.createElement("option");
                option.value = cat.id;
                option.textContent = (cat.emoji ? cat.emoji + " " : "") + cat.name;
                select.appendChild(option);
            });

            // Restore previous selection if it still exists
            if ([...select.options].some(o => o.value === previousValue)) {
                select.value = previousValue;
            }
        });
    }

    function renderCategoryManagerList() {
        if (!el.categoryList) return;
        el.categoryList.innerHTML = ""; // safe: rebuilding from scratch with createElement below

        categories.forEach(cat => {
            const li = document.createElement("li");

            const label = document.createElement("span");
            label.textContent = (cat.emoji ? cat.emoji + " " : "") + cat.name; // safe text insertion

            const deleteBtn = document.createElement("button");
            deleteBtn.type = "button";
            deleteBtn.className = "delete-category-btn";
            deleteBtn.dataset.category = cat.id;
            deleteBtn.textContent = "Delete";
            deleteBtn.addEventListener("click", () => handleDeleteCategory(cat.id));

            li.appendChild(label);
            li.appendChild(deleteBtn);
            el.categoryList.appendChild(li);
        });
    }

    /** Build one transaction row (safe DOM nodes only). Includes the
     *  category name/emoji inline since rows are no longer grouped. */
    function buildEntryRow(transaction) {
        const row = document.createElement("div");
        row.className = "entry-row";

        const cat = getCategoryById(transaction.category);
        const categoryLabel = cat ? ((cat.emoji ? cat.emoji + " " : "") + cat.name) : "🏷️ Other";

        const dateSpan = document.createElement("span");
        dateSpan.className = "entry-date";
        dateSpan.textContent = formatShortDate(transaction.date);

        const categorySpan = document.createElement("span");
        categorySpan.className = "entry-category";
        categorySpan.textContent = categoryLabel;

        const descSpan = document.createElement("span");
        descSpan.className = "entry-description";
        descSpan.textContent = transaction.description || "(no description)";

        const amountSpan = document.createElement("span");
        amountSpan.className = "entry-amount " + (transaction.type === "pocket-money" ? "income" : "expense");
        const sign = transaction.type === "pocket-money" ? "+" : "-";
        amountSpan.textContent = sign + formatCurrency(transaction.amount);

        const deleteBtn = document.createElement("button");
        deleteBtn.type = "button";
        deleteBtn.className = "delete-entry-btn";
        deleteBtn.dataset.id = transaction.id;
        deleteBtn.textContent = "Delete";
        deleteBtn.addEventListener("click", () => handleDeleteTransaction(transaction.id));

        row.appendChild(dateSpan);
        row.appendChild(categorySpan);
        row.appendChild(descSpan);
        row.appendChild(amountSpan);
        row.appendChild(deleteBtn);

        return row;
    }

    const PAGE_SIZE = 5;
    let currentPage = 1; // 1-indexed, like a real pagination UI

    /** Returns the current filtered + sorted transaction list, without
     *  slicing to a page yet. Shared by the renderer and the pager. */
    function getFilteredSortedTransactions() {
        const searchTerm = ((el.searchInput && el.searchInput.value) || "").trim().toLowerCase();
        const typeFilter = (el.filterTypeSelect && el.filterTypeSelect.value) || "all";
        const categoryFilter = (el.filterCategorySelect && el.filterCategorySelect.value) || "all";
        const sortMode = (el.sortSelect && el.sortSelect.value) || "newest";

        let filtered = transactions.filter(t => {
            if (typeFilter !== "all" && t.type !== typeFilter) return false;
            if (categoryFilter !== "all" && t.category !== categoryFilter) return false;

            if (searchTerm) {
                const cat = getCategoryById(t.category);
                const haystack = [
                    t.description || "",
                    cat ? cat.name : "",
                    String(t.amount)
                ].join(" ").toLowerCase();
                if (!haystack.includes(searchTerm)) return false; // plain substring match — no regex, avoids ReDoS
            }

            return true;
        });

        filtered = filtered.slice().sort((a, b) => {
            switch (sortMode) {
                case "oldest":
                    return new Date(a.date) - new Date(b.date);
                case "highest":
                    return b.amount - a.amount;
                case "lowest":
                    return a.amount - b.amount;
                case "newest":
                default:
                    return new Date(b.date) - new Date(a.date);
            }
        });

        return filtered;
    }

    /** Renders exactly one page (PAGE_SIZE transactions) as a flat,
     *  banking-app-style list, and updates the pagination controls
     *  to match. Called whenever transactions, filters, or the
     *  current page change. */
    function renderTransactionLog() {
        if (!el.transactionLog) return;

        const filtered = getFilteredSortedTransactions();
        const totalPages = Math.max(Math.ceil(filtered.length / PAGE_SIZE), 1);

        // Clamp current page in case transactions were deleted/filtered
        // out from under it (e.g. deleting the last item on the last page).
        if (currentPage > totalPages) currentPage = totalPages;
        if (currentPage < 1) currentPage = 1;

        const startIndex = (currentPage - 1) * PAGE_SIZE;
        const pageItems = filtered.slice(startIndex, startIndex + PAGE_SIZE);

        el.transactionLog.innerHTML = ""; // safe: rebuilding with createElement below
        pageItems.forEach(t => el.transactionLog.appendChild(buildEntryRow(t)));

        renderPaginationControls(totalPages, filtered.length);
    }

    /** Updates the page indicator text and enables/disables the
     *  First/Prev/Next/Last arrow buttons appropriately. */
    function renderPaginationControls(totalPages, totalItems) {
        if (el.pageIndicator) {
            el.pageIndicator.textContent = totalItems === 0
                ? "No transactions"
                : "Page " + currentPage + " of " + totalPages;
        }

        const atFirstPage = currentPage <= 1;
        const atLastPage = currentPage >= totalPages;

        [el.pageFirstBtn, el.pagePrevBtn].forEach(btn => {
            if (btn) btn.disabled = atFirstPage;
        });
        [el.pageNextBtn, el.pageLastBtn].forEach(btn => {
            if (btn) btn.disabled = atLastPage;
        });
    }

    function goToFirstPage() {
        currentPage = 1;
        renderTransactionLog();
    }

    function goToPrevPage() {
        currentPage = Math.max(currentPage - 1, 1);
        renderTransactionLog();
    }

    function goToNextPage() {
        const filtered = getFilteredSortedTransactions();
        const totalPages = Math.max(Math.ceil(filtered.length / PAGE_SIZE), 1);
        currentPage = Math.min(currentPage + 1, totalPages);
        renderTransactionLog();
    }

    function goToLastPage() {
        const filtered = getFilteredSortedTransactions();
        const totalPages = Math.max(Math.ceil(filtered.length / PAGE_SIZE), 1);
        currentPage = totalPages;
        renderTransactionLog();
    }

    /** Whenever search/filter/sort changes, jump back to page 1 —
     *  staying on e.g. "page 3" after a filter change could show an
     *  empty or confusing page. */
    function handleFilterChange() {
        currentPage = 1;
        renderTransactionLog();
    }

    function renderAll() {
        renderDashboard();
        renderCircle();
        renderCategoryOptions();
        renderCategoryManagerList();
        renderTransactionLog();
    }


    /* =====================================================
       ACTIONS
       ===================================================== */

    function addTransaction({ type, amount, category, description, date }) {
        const safeAmount = parseSafeAmount(amount);
        const safeDate = parseSafeDate(date);
        const safeDescription = sanitizeText(description, LIMITS.descriptionMaxLength);
        const safeType = type === "pocket-money" ? "pocket-money" : "expense";
        const categoryExists = getCategoryById(category) !== null;

        if (safeAmount === null) {
            alert("Please enter a valid amount between " + LIMITS.minAmount + " and " + LIMITS.maxAmount + ".");
            return false;
        }
        if (!safeDate) {
            alert("Please enter a valid date.");
            return false;
        }
        if (!safeDescription) {
            alert("Please enter a description.");
            return false;
        }
        if (!categoryExists) {
            alert("Please choose a valid category.");
            return false;
        }

        const transaction = {
            id: generateId(),
            type: safeType,
            amount: safeAmount,
            category: category,
            description: safeDescription,
            date: safeDate
        };

        transactions.push(transaction);
        saveToStorage(STORAGE_KEYS.transactions, transactions);
        currentPage = 1; // jump to page 1 so the new entry is visible right away
        renderAll();
        return true;
    }

    function handleDeleteTransaction(id) {
        const index = transactions.findIndex(t => t.id === id);
        if (index === -1) return;

        showConfirmModal("Delete this transaction?", () => {
            lastDeleted = transactions[index];
            transactions.splice(index, 1);
            saveToStorage(STORAGE_KEYS.transactions, transactions);
            renderAll();
            showUndoToast("Transaction deleted.");
        });
    }

    function undoLastDelete() {
        if (!lastDeleted) return;
        // Re-validate before restoring, in case anything odd happened
        if (isValidTransaction(lastDeleted)) {
            transactions.push(lastDeleted);
            saveToStorage(STORAGE_KEYS.transactions, transactions);
            renderAll();
        }
        lastDeleted = null;
        hideUndoToast();
    }

    function showUndoToast(message) {
        if (!el.undoToast) return;
        if (el.undoToastMessage) el.undoToastMessage.textContent = message;
        el.undoToast.classList.remove("hidden");

        clearTimeout(undoTimer);
        undoTimer = setTimeout(() => {
            lastDeleted = null;
            hideUndoToast();
        }, 5000);
    }

    function hideUndoToast() {
        if (!el.undoToast) return;
        el.undoToast.classList.add("hidden");
        clearTimeout(undoTimer);
    }

    function handleClearAll() {
        if (transactions.length === 0) return;

        showConfirmModal(
            "This will permanently delete ALL transactions. This cannot be undone. Continue?",
            () => {
                transactions = [];
                saveToStorage(STORAGE_KEYS.transactions, transactions);
                renderAll();
            }
        );
    }

    function handleAddCategory() {
        if (!el.newCategoryInput) return;

        const rawName = el.newCategoryInput.value;
        const safeName = sanitizeText(rawName, LIMITS.categoryNameMaxLength);

        if (!safeName) {
            alert("Please enter a category name.");
            return;
        }
        if (categories.length >= LIMITS.maxCategories) {
            alert("Category limit reached (" + LIMITS.maxCategories + ").");
            return;
        }

        const id = slugify(safeName);
        if (!id) {
            alert("Please use a category name with at least one letter or number.");
            return;
        }
        if (getCategoryById(id)) {
            alert("A category with that name already exists.");
            return;
        }

        // Emoji is optional. Only accept it if it came from our own
        // picker (short string); anything unexpectedly long is dropped
        // rather than trusted, since the hidden field could in theory
        // be tampered with via devtools.
        let emoji = "";
        if (el.selectedEmojiValue && el.selectedEmojiValue.value) {
            const rawEmoji = sanitizeText(el.selectedEmojiValue.value, LIMITS.emojiMaxLength);
            emoji = rawEmoji;
        }

        categories.push({ id, name: safeName, emoji });
        saveToStorage(STORAGE_KEYS.categories, categories);

        // Reset the form
        el.newCategoryInput.value = "";
        if (el.selectedEmojiValue) el.selectedEmojiValue.value = "";
        if (el.selectedEmojiPreview) el.selectedEmojiPreview.textContent = "🙂";

        renderAll();
    }

    function handleDeleteCategory(categoryId) {
        const inUse = transactions.some(t => t.category === categoryId);
        const message = inUse
            ? "This category has existing transactions, which will be labeled \"Other\" once it's deleted. Continue?"
            : "Delete this category?";

        showConfirmModal(message, () => {
            categories = categories.filter(c => c.id !== categoryId);

            // Guard: never allow zero categories, restore defaults if so
            if (categories.length === 0) {
                categories = DEFAULT_CATEGORIES.slice();
            }

            saveToStorage(STORAGE_KEYS.categories, categories);
            renderAll();
        });
    }

    function handleSaveBudget() {
        const monthlyBudgetRaw = el.monthlyBudgetInput ? el.monthlyBudgetInput.value : "0";
        const thresholdRaw = el.lowBalanceThresholdInput ? el.lowBalanceThresholdInput.value : "1000";
        const overrideRaw = el.dailySafeSpendOverrideInput ? el.dailySafeSpendOverrideInput.value : "";

        const monthlyBudgetNum = Number(monthlyBudgetRaw);
        const thresholdNum = Number(thresholdRaw);

        const safeBudget = Number.isFinite(monthlyBudgetNum) && monthlyBudgetNum >= 0
            ? Math.min(monthlyBudgetNum, LIMITS.maxAmount)
            : 0;

        const safeThreshold = Number.isFinite(thresholdNum) && thresholdNum >= 0
            ? Math.min(thresholdNum, LIMITS.maxAmount)
            : DEFAULT_BUDGET.lowBalanceThreshold;

        // Override is optional: blank input = null = auto-calculate.
        // Any invalid/negative value is also treated as "no override"
        // rather than silently accepted.
        let safeOverride = null;
        if (overrideRaw.trim() !== "") {
            const overrideNum = Number(overrideRaw);
            if (Number.isFinite(overrideNum) && overrideNum >= 0) {
                safeOverride = Math.min(overrideNum, LIMITS.maxAmount);
            }
        }

        budget = {
            monthlyBudget: safeBudget,
            lowBalanceThreshold: safeThreshold,
            dailySafeSpendOverride: safeOverride
        };
        saveToStorage(STORAGE_KEYS.budget, budget);
        renderAll();
    }

    function handleQuickAdd(button) {
        const categoryId = button.dataset.category;
        const description = button.dataset.description || "";
        const amount = button.dataset.amount || "0";

        // If a matching category doesn't exist yet (e.g. it was
        // deleted), fall back to the first available category
        // rather than silently failing.
        const categoryToUse = getCategoryById(categoryId) ? categoryId : (categories[0] && categories[0].id);
        if (!categoryToUse) return;

        const today = new Date().toISOString().slice(0, 10);

        addTransaction({
            type: "expense",
            amount: amount,
            category: categoryToUse,
            description: description || "Quick add",
            date: today
        });
    }


    /* =====================================================
       CONFIRMATION MODAL
       Replaces window.confirm() with a themed in-app dialog.
       Usage: showConfirmModal("message", onConfirmCallback)
       The callback only runs if the user clicks "Yes, Continue".
       ===================================================== */

    let pendingConfirmAction = null;

    function showConfirmModal(message, onConfirm) {
        if (!el.confirmOverlay) {
            // Fallback for safety if the modal markup is ever missing —
            // degrade to the native confirm rather than silently do nothing.
            if (window.confirm(message)) onConfirm();
            return;
        }
        if (el.confirmMessage) el.confirmMessage.textContent = message;
        pendingConfirmAction = onConfirm;
        el.confirmOverlay.classList.remove("hidden");
    }

    function closeConfirmModal() {
        if (!el.confirmOverlay) return;
        el.confirmOverlay.classList.add("hidden");
        pendingConfirmAction = null;
    }

    function handleConfirmModalConfirm() {
        const action = pendingConfirmAction;
        closeConfirmModal();
        if (typeof action === "function") action();
    }


    /* =====================================================
       QUICK-ADD EDITOR
       Lets the user customize the description + amount of each
       of the 4 quick-add buttons. Category and emoji stay fixed
       per slot (keeps the UI simple); only the two fields that
       matter day-to-day (what it's called, how much) are editable.
       Persisted to localStorage so edits survive a reload.
       ===================================================== */

    const QUICK_ADD_SLOT_IDS = ["qa-btn-1", "qa-btn-2", "qa-btn-3", "qa-btn-4"];

    function isValidQuickAddConfig(cfg) {
        return (
            cfg && typeof cfg === "object" &&
            QUICK_ADD_SLOT_IDS.every(id => {
                const entry = cfg[id];
                return entry && typeof entry === "object" &&
                    typeof entry.description === "string" &&
                    typeof entry.amount === "number" &&
                    Number.isFinite(entry.amount) &&
                    entry.amount >= LIMITS.minAmount &&
                    entry.amount <= LIMITS.maxAmount;
            })
        );
    }

    let quickAddConfig = loadFromStorage(STORAGE_KEYS.quickAdd, isValidQuickAddConfig, null);

    /** Apply the current quickAddConfig (or the button's original
     *  HTML defaults, if no override is saved yet) onto the actual
     *  DOM buttons — updates both the data-* attributes used by
     *  handleQuickAdd() and the visible label text. */
    function applyQuickAddConfig() {
        QUICK_ADD_SLOT_IDS.forEach(id => {
            const btn = document.getElementById(id);
            if (!btn) return;

            const override = quickAddConfig && quickAddConfig[id];
            const description = override ? override.description : btn.dataset.description;
            const amount = override ? override.amount : btn.dataset.amount;

            btn.dataset.description = description;
            btn.dataset.amount = String(amount);

            const labelSpan = btn.querySelector(".qa-label");
            if (labelSpan) labelSpan.textContent = description;
        });
    }

    function openQuickAddEditor() {
        if (!el.quickAddEditOverlay) return;

        QUICK_ADD_SLOT_IDS.forEach((id, index) => {
            const btn = document.getElementById(id);
            const descInput = document.getElementById("qa-edit-desc-" + (index + 1));
            const amountInput = document.getElementById("qa-edit-amount-" + (index + 1));
            if (!btn || !descInput || !amountInput) return;

            descInput.value = btn.dataset.description || "";
            amountInput.value = btn.dataset.amount || "";
        });

        el.quickAddEditOverlay.classList.remove("hidden");
    }

    function closeQuickAddEditor() {
        if (!el.quickAddEditOverlay) return;
        el.quickAddEditOverlay.classList.add("hidden");
    }

    function saveQuickAddEditor() {
        const newConfig = {};

        for (let i = 0; i < QUICK_ADD_SLOT_IDS.length; i++) {
            const id = QUICK_ADD_SLOT_IDS[i];
            const descInput = document.getElementById("qa-edit-desc-" + (i + 1));
            const amountInput = document.getElementById("qa-edit-amount-" + (i + 1));
            if (!descInput || !amountInput) continue;

            const safeDescription = sanitizeText(descInput.value, LIMITS.descriptionMaxLength);
            const safeAmount = parseSafeAmount(amountInput.value);

            if (!safeDescription) {
                alert("Please fill in a description for every quick-add button.");
                return;
            }
            if (safeAmount === null) {
                alert("Please enter a valid amount (" + LIMITS.minAmount + "–" + LIMITS.maxAmount + ") for every quick-add button.");
                return;
            }

            newConfig[id] = { description: safeDescription, amount: safeAmount };
        }

        quickAddConfig = newConfig;
        saveToStorage(STORAGE_KEYS.quickAdd, quickAddConfig);
        applyQuickAddConfig();
        closeQuickAddEditor();
    }


    /* =====================================================
       EVENT WIRING
       ===================================================== */

    function initFormDefaults() {
        // Default the date field to today — most entries are same-day
        if (el.dateInput && !el.dateInput.value) {
            el.dateInput.value = new Date().toISOString().slice(0, 10);
        }
        if (el.monthlyBudgetInput) el.monthlyBudgetInput.value = budget.monthlyBudget || "";
        if (el.lowBalanceThresholdInput) el.lowBalanceThresholdInput.value = budget.lowBalanceThreshold;
        if (el.dailySafeSpendOverrideInput) {
            el.dailySafeSpendOverrideInput.value =
                typeof budget.dailySafeSpendOverride === "number" ? budget.dailySafeSpendOverride : "";
        }
    }

    function bindEvents() {
        if (el.form) {
            el.form.addEventListener("submit", (e) => {
                e.preventDefault(); // never let the browser do a real form submission/navigation

                const success = addTransaction({
                    type: el.typeInput.value,
                    amount: el.amountInput.value,
                    category: el.categoryInput.value,
                    description: el.descriptionInput.value,
                    date: el.dateInput.value
                });

                if (success) {
                    el.form.reset();
                    initFormDefaults();
                }
            });
        }

        el.quickAddButtons.forEach(btn => {
            btn.addEventListener("click", () => handleQuickAdd(btn));
        });

        if (el.addCategoryBtn) {
            el.addCategoryBtn.addEventListener("click", handleAddCategory);
        }

        if (el.saveBudgetBtn) {
            el.saveBudgetBtn.addEventListener("click", handleSaveBudget);
        }

        if (el.clearAllBtn) {
            el.clearAllBtn.addEventListener("click", handleClearAll);
        }

        if (el.undoDeleteBtn) {
            el.undoDeleteBtn.addEventListener("click", undoLastDelete);
        }

        if (el.searchInput) {
            el.searchInput.addEventListener("input", debounce(handleFilterChange, 200));
        }
        if (el.filterTypeSelect) {
            el.filterTypeSelect.addEventListener("change", handleFilterChange);
        }
        if (el.filterCategorySelect) {
            el.filterCategorySelect.addEventListener("change", handleFilterChange);
        }
        if (el.sortSelect) {
            el.sortSelect.addEventListener("change", handleFilterChange);
        }

        if (el.pageFirstBtn) el.pageFirstBtn.addEventListener("click", goToFirstPage);
        if (el.pagePrevBtn) el.pagePrevBtn.addEventListener("click", goToPrevPage);
        if (el.pageNextBtn) el.pageNextBtn.addEventListener("click", goToNextPage);
        if (el.pageLastBtn) el.pageLastBtn.addEventListener("click", goToLastPage);

        // Edit Quick-Add
        if (el.editQuickAddBtn) {
            el.editQuickAddBtn.addEventListener("click", openQuickAddEditor);
        }
        if (el.quickAddEditCancelBtn) {
            el.quickAddEditCancelBtn.addEventListener("click", closeQuickAddEditor);
        }
        if (el.quickAddEditSaveBtn) {
            el.quickAddEditSaveBtn.addEventListener("click", saveQuickAddEditor);
        }
        // Click on the dark overlay itself (outside the box) also cancels
        if (el.quickAddEditOverlay) {
            el.quickAddEditOverlay.addEventListener("click", (e) => {
                if (e.target === el.quickAddEditOverlay) closeQuickAddEditor();
            });
        }

        // Confirmation modal
        if (el.confirmCancelBtn) {
            el.confirmCancelBtn.addEventListener("click", closeConfirmModal);
        }
        if (el.confirmConfirmBtn) {
            el.confirmConfirmBtn.addEventListener("click", handleConfirmModalConfirm);
        }
        if (el.confirmOverlay) {
            el.confirmOverlay.addEventListener("click", (e) => {
                if (e.target === el.confirmOverlay) closeConfirmModal();
            });
        }
    }


    /* =====================================================
       INIT
       ===================================================== */

    function init() {
        // If categories were reset to defaults for the first time,
        // persist them so future loads are consistent.
        if (!window.localStorage.getItem(STORAGE_KEYS.categories)) {
            saveToStorage(STORAGE_KEYS.categories, categories);
        }
        if (!window.localStorage.getItem(STORAGE_KEYS.budget)) {
            saveToStorage(STORAGE_KEYS.budget, budget);
        }

        applyQuickAddConfig();
        initFormDefaults();
        bindEvents();
        renderAll();
    }

    document.addEventListener("DOMContentLoaded", init);

})();


/* =========================================================
   emoji-data.js
   A curated, phone-keyboard-style emoji collection grouped
   by category, plus the logic to power the Add Category
   emoji picker in index.html.

   Include this BEFORE script.js:
     <script src="emoji-data.js"></script>
     <script src="script.js"></script>
   ========================================================= */

const EMOJI_DATA = {

    smileys: [
        "😀","😃","😄","😁","😆","😅","🤣","😂","🙂","🙃",
        "😉","😊","😇","🥰","😍","🤩","😘","😗","😚","😙",
        "😋","😛","😜","🤪","😝","🤑","🤗","🤭","🤫","🤔",
        "🤐","🤨","😐","😑","😶","😏","😒","🙄","😬","🤥",
        "😌","😔","😪","🤤","😴","😷","🤒","🤕","🤢","🤮",
        "🥵","🥶","🥴","😵","🤯","🤠","🥳","😎","🤓","🧐",
        "😕","😟","🙁","☹️","😮","😯","😲","😳","🥺","😦",
        "😧","😨","😰","😥","😢","😭","😱","😖","😣","😞",
        "😓","😩","😫","🥱","😤","😡","😠","🤬","😈","👿",
        "💀","☠️","💩","🤡","👹","👺","👻","👽","🤖","😺",
        "😸","😹","😻","😼","😽","🙀","😿","😾"
    ],

    animals: [
        "🐶","🐱","🐭","🐹","🐰","🦊","🐻","🐼","🐨","🐯",
        "🦁","🐮","🐷","🐸","🐵","🙈","🙉","🙊","🐒","🐔",
        "🐧","🐦","🐤","🐣","🐥","🦆","🦅","🦉","🦇","🐺",
        "🐗","🐴","🦄","🐝","🐛","🦋","🐌","🐞","🐜","🦟",
        "🦗","🕷️","🕸️","🐢","🐍","🦎","🦖","🦕","🐙","🦑",
        "🦐","🦞","🦀","🐡","🐠","🐟","🐬","🐳","🐋","🦈",
        "🐊","🐅","🐆","🦓","🦍","🦧","🐘","🦛","🦏","🐪",
        "🐫","🦒","🦘","🐃","🐂","🐄","🐎","🐖","🐏","🐑",
        "🦙","🐐","🦌","🐕","🐩","🦮","🐕‍🦺","🐈","🐓","🦃",
        "🦚","🦜","🦢","🦩","🕊️","🐇","🦝","🦨","🦡","🦦",
        "🦥","🐁","🐀","🐿️","🦔","🌵","🌲","🌳","🌴","🌱",
        "🌿","☘️","🍀","🎋","🍃","🍂","🍁","🍄","🌾","💐",
        "🌷","🌹","🥀","🌺","🌸","🌼","🌻"
    ],

    food: [
        "🍏","🍎","🍐","🍊","🍋","🍌","🍉","🍇","🍓","🫐",
        "🍈","🍒","🍑","🥭","🍍","🥥","🥝","🍅","🍆","🥑",
        "🥦","🥬","🥒","🌶️","🫑","🌽","🥕","🫒","🧄","🧅",
        "🥔","🍠","🥐","🥯","🍞","🥖","🥨","🧀","🥚","🍳",
        "🧈","🥞","🧇","🥓","🥩","🍗","🍖","🌭","🍔","🍟",
        "🍕","🫓","🥪","🥙","🧆","🌮","🌯","🫔","🥗","🥘",
        "🫕","🥫","🍝","🍜","🍲","🍛","🍣","🍱","🥟","🦪",
        "🍤","🍙","🍚","🍘","🍥","🥠","🥮","🍢","🍡","🍧",
        "🍨","🍦","🥧","🧁","🍰","🎂","🍮","🍭","🍬","🍫",
        "🍿","🍩","🍪","🌰","🥜","🍯","🥛","🍼","☕","🫖",
        "🍵","🍶","🍾","🍷","🍸","🍹","🍺","🍻","🥂","🥃",
        "🥤","🧋","🧃","🧉","🧊"
    ],

    activity: [
        "⚽","🏀","🏈","⚾","🥎","🎾","🏐","🏉","🥏","🎱",
        "🪀","🏓","🏸","🏒","🏑","🥍","🏏","🥅","⛳","🪁",
        "🏹","🎣","🤿","🥊","🥋","🎽","🛹","🛼","🛷","⛸️",
        "🥌","🎿","⛷️","🏂","🪂","🏋️","🤼","🤸","⛹️","🤺",
        "🤾","🏌️","🏇","🧘","🏄","🏊","🤽","🚣","🧗","🚵",
        "🚴","🏆","🥇","🥈","🥉","🏅","🎖️","🏵️","🎗️","🎫",
        "🎟️","🎪","🤹","🎭","🩰","🎨","🎬","🎤","🎧","🎼",
        "🎹","🥁","🎷","🎺","🎸","🪕","🎻","🎲","♟️","🎯",
        "🎳","🎮","🎰","🧩"
    ],

    travel: [
        "🚗","🚕","🚙","🚌","🚎","🏎️","🚓","🚑","🚒","🚐",
        "🛻","🚚","🚛","🚜","🦽","🦼","🛵","🏍️","🛺","🚲",
        "🛴","🚨","🚔","🚍","🚘","🚖","🚡","🚠","🚟","🚃",
        "🚋","🚞","🚝","🚄","🚅","🚈","🚂","🚆","🚇","🚊",
        "🚉","✈️","🛫","🛬","🛩️","💺","🛰️","🚀","🛸","🚁",
        "🛶","⛵","🚤","🛥️","🛳️","⛴️","🚢","⚓","🪝","⛽",
        "🚧","🚦","🚥","🗺️","🗿","🗽","🗼","🏰","🏯","🏟️",
        "🎡","🎢","🎠","⛲","⛱️","🏖️","🏝️","🏜️","🌋","⛰️",
        "🏔️","🗻","🏕️","⛺","🏠","🏡","🏘️","🏚️","🏗️","🏭",
        "🏢","🏬","🏣","🏤","🏥","🏦","🏨","🏪","🏫","🏩",
        "💒","🏛️","⛪","🕌","🕍","🛕","🕋","⛩️","🛤️","🌁",
        "🌃","🏙️","🌄","🌅","🌆","🌇","🌉","♨️"
    ],

    objects: [
        "⌚","📱","💻","⌨️","🖥️","🖨️","🖱️","🖲️","🕹️","💽",
        "💾","💿","📀","📼","📷","📸","📹","🎥","📞","☎️",
        "📟","📠","📺","📻","🎙️","🎚️","🎛️","🧭","⏱️","⏲️",
        "⏰","🕰️","⌛","⏳","📡","🔋","🔌","💡","🔦","🕯️",
        "🪔","🧯","🛢️","💸","💵","💴","💶","💷","🪙","💰",
        "💳","🧾","💎","⚖️","🪜","🧰","🪛","🔧","🔨","⚒️",
        "🛠️","⛏️","🪚","🔩","⚙️","🪤","🧱","⛓️","🧲","🔫",
        "💣","🧨","🪓","🔪","🗡️","⚔️","🛡️","🚬","⚰️","🪦",
        "⚱️","🏺","🔮","📿","🧿","💈","⚗️","🔭","🔬","🕳️",
        "🩹","🩺","💊","💉","🩸","🧬","🦠","🧫","🧪","🌡️",
        "🧹","🪠","🧺","🧻","🚽","🚰","🚿","🛁","🛀","🧼",
        "🪥","🪒","🧽","🪣","🧴","🛎️","🔑","🗝️","🚪","🪑",
        "🛋️","🛏️","🛌","🖼️","🪞","🪟","🛍️","🛒","🎁","🎈",
        "🎏","🎀","🪄","🪅","🎊","🎉","🎎","🏮","🎐","🧧",
        "✉️","📩","📨","📧","💌","📥","📤","📦","🏷️","🪧",
        "📪","📫","📬","📭","📮","📯","📜","📃","📄","📑",
        "🧾","📊","📈","📉","🗒️","🗓️","📅","📆","🗑️","📇",
        "🗃️","🗳️","🗄️","📋","📁","📂","🗂️","🗞️","📰","📓",
        "📔","📒","📕","📗","📘","📙","📚","📖","🔖","🧷",
        "🔗","📎","🖇️","📐","📏","🧮","📌","📍","✂️","🖊️",
        "🖋️","✒️","🖌️","🖍️","📝","✏️","🔍","🔎","🔏","🔐",
        "🔒","🔓"
    ],

    symbols: [
        "❤️","🧡","💛","💚","💙","💜","🖤","🤍","🤎","💔",
        "❣️","💕","💞","💓","💗","💖","💘","💝","💟","☮️",
        "✝️","☪️","🕉️","☸️","✡️","🔯","🕎","☯️","☦️","🛐",
        "⛎","♈","♉","♊","♋","♌","♍","♎","♏","♐",
        "♑","♒","♓","🆔","⚛️","🉑","☢️","☣️","📴","📳",
        "🈶","🈚","🈸","🈺","🈷️","✴️","🆚","💮","🉐","㊙️",
        "㊗️","🈴","🈵","🈹","🈲","🅰️","🅱️","🆎","🆑","🅾️",
        "🆘","❌","⭕","🛑","⛔","📛","🚫","💯","💢","♨️",
        "🚷","🚯","🚳","🚱","🔞","📵","🚭","❗","❕","❓",
        "❔","‼️","⁉️","🔅","🔆","〽️","⚠️","🚸","🔱","⚜️",
        "🔰","♻️","✅","🈯","💹","❇️","✳️","❎","🌐","💠",
        "Ⓜ️","🌀","💤","🏧","🚾","♿","🅿️","🈳","🈂️","🛂",
        "🛃","🛄","🛅","🚹","🚺","🚼","⚧️","🚻","🚮","🎦",
        "📶","🈁","🔣","ℹ️","🔤","🔡","🔠","🆖","🆗","🆙",
        "🆒","🆕","🆓","0️⃣","1️⃣","2️⃣","3️⃣","4️⃣","5️⃣","6️⃣",
        "7️⃣","8️⃣","9️⃣","🔟","🔢","#️⃣","*️⃣","⏏️","▶️","⏸️",
        "⏯️","⏹️","⏺️","⏭️","⏮️","⏩","⏪","⏫","⏬","◀️",
        "🔼","🔽","➡️","⬅️","⬆️","⬇️","↗️","↘️","↙️","↖️",
        "↕️","↔️","↪️","↩️","⤴️","⤵️","🔀","🔁","🔂","🔄",
        "🔃","🎵","🎶","➕","➖","➗","✖️","🟰","♾️","💲",
        "💱","™️","©️","®️","👁️‍🗨️","🔚","🔙","🔛","🔝","🔜",
        "✔️","☑️","🔘","🔴","🟠","🟡","🟢","🔵","🟣","⚫",
        "⚪","🟤","🔺","🔻","🔸","🔹","🔶","🔷","🔳","🔲",
        "▪️","▫️","◾","◽","◼️","◻️","🟥","🟧","🟨","🟩",
        "🟦","🟪","⬛","⬜","🟫"
    ]
};

/* Flat list (all categories combined) — used when the user searches
   or wants to browse everything at once.
   NOTE: written without Array.prototype.flat() intentionally — some
   older mobile browsers / WebViews don't support it. concat() with
   apply() works everywhere, back to very old JS engines. */
const EMOJI_ALL = [].concat.apply([], Object.values(EMOJI_DATA));


/* =========================================================
   Picker wiring
   Handles: opening/closing the popover, switching category
   tabs, rendering the grid, live search, selecting an emoji,
   and clearing the selection ("None" = add category without
   an emoji, which is the default / optional behavior).
   ========================================================= */

document.addEventListener("DOMContentLoaded", () => {

    const trigger      = document.getElementById("emoji-picker-trigger");
    const popover      = document.getElementById("emoji-picker-popover");
    const grid         = document.getElementById("emoji-grid");
    const searchInput  = document.getElementById("emoji-search");
    const clearBtn     = document.getElementById("emoji-clear-btn");
    const preview      = document.getElementById("selected-emoji-preview");
    const hiddenValue  = document.getElementById("selected-emoji-value");
    const tabs         = document.querySelectorAll(".emoji-tab");

    if (!trigger || !popover || !grid) return; // structure not present, skip

    let activeTab = "smileys";

    function renderGrid(list) {
        grid.innerHTML = "";
        list.forEach(emoji => {
            const btn = document.createElement("button");
            btn.type = "button";
            btn.className = "emoji-option";
            btn.dataset.emoji = emoji;
            btn.textContent = emoji;
            btn.addEventListener("click", () => selectEmoji(emoji));
            grid.appendChild(btn);
        });
    }

    function selectEmoji(emoji) {
        hiddenValue.value = emoji;
        preview.textContent = emoji;
        closePopover();
    }

    function clearEmoji() {
        hiddenValue.value = "";
        preview.textContent = "🙂"; // neutral placeholder, means "no emoji chosen"
        closePopover();
    }

    function openPopover() {
        popover.classList.remove("hidden");
        renderGrid(EMOJI_DATA[activeTab]);
        searchInput.value = "";
        searchInput.focus();
    }

    function closePopover() {
        popover.classList.add("hidden");
    }

    trigger.addEventListener("click", (e) => {
        e.stopPropagation();
        popover.classList.contains("hidden") ? openPopover() : closePopover();
    });

    clearBtn.addEventListener("click", clearEmoji);

    tabs.forEach(tab => {
        tab.addEventListener("click", () => {
            tabs.forEach(t => t.classList.remove("active"));
            tab.classList.add("active");
            activeTab = tab.dataset.tab;
            searchInput.value = "";
            renderGrid(EMOJI_DATA[activeTab]);
        });
    });

    searchInput.addEventListener("input", () => {
        const query = searchInput.value.trim().toLowerCase();
        if (!query) {
            renderGrid(EMOJI_DATA[activeTab]);
            return;
        }
        // Simple search: since emoji have no text labels here,
        // searching just shows the full combined set for now.
        // (Optional upgrade: map emoji -> keywords for real text search.)
        renderGrid(EMOJI_ALL);
    });

    // Close popover when clicking outside of it
    document.addEventListener("click", (e) => {
        if (!popover.contains(e.target) && e.target !== trigger) {
            closePopover();
        }
    });

});