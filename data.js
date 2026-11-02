(() => {
  const callbacks = new Set();
  let client;
  let activeUserId;
  let realtimeChannel;
  let refreshQueue = Promise.resolve();
  let writeQueue = Promise.resolve();
  let syncPromise;
  let recordRevision = 0;
  let offlineDbPromise;
  const offlineDbName = 'daymark-dashboard-offline';

  function openOfflineDb() {
    if (!offlineDbPromise) {
      offlineDbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(offlineDbName, 1);
        request.onupgradeneeded = () => {
          request.result.createObjectStore('users', { keyPath: 'userId' });
        };
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }
    return offlineDbPromise;
  }

  async function readOfflineState(userId) {
    const db = await openOfflineDb();
    return new Promise((resolve, reject) => {
      const request = db.transaction('users', 'readonly').objectStore('users').get(userId);
      request.onsuccess = () => resolve(request.result || { userId, records: [], pending: [] });
      request.onerror = () => reject(request.error);
    });
  }

  async function updateOfflineState(userId, update) {
    const db = await openOfflineDb();
    return new Promise((resolve, reject) => {
      const transaction = db.transaction('users', 'readwrite');
      const store = transaction.objectStore('users');
      const request = store.get(userId);
      let updatedState;
      let updateError;
      request.onsuccess = () => {
        try {
          updatedState = update(request.result || { userId, records: [], pending: [] });
          store.put(updatedState);
        } catch (error) {
          updateError = error;
          transaction.abort();
        }
      };
      transaction.oncomplete = () => resolve(updatedState);
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(updateError || transaction.error || new Error('Could not save offline dashboard data.'));
    });
  }

  function serializeWrite(operation) {
    const request = writeQueue.catch(() => {}).then(operation);
    writeQueue = request;
    return request;
  }

  function setSyncStatus(text, connected = false) {
    document.querySelectorAll('.dashboard-sync-status').forEach(status => {
      status.textContent = text;
      status.dataset.connected = String(connected);
      status.dataset.error = String(/failed|offline|waiting|unavailable/i.test(text));
      status.title = text;
      status.setAttribute('aria-label', text);
    });
  }

  function getClient() {
    if (client) return client;
    const config = window.SUPABASE_CONFIG || {};
    if (!config.url || !config.anonKey) {
      throw new Error('Add the Supabase project URL and publishable key to supabase-config.js.');
    }
    if (!window.supabase?.createClient) {
      throw new Error('The Supabase client could not load. Check your internet connection and reload.');
    }
    client = window.supabase.createClient(config.url, config.anonKey);
    return client;
  }

  function toRecord(row) {
    return { ...row.record, __backendId: row.id };
  }

  async function getCurrentUser() {
    const { data, error } = await getClient().auth.getSession();
    if (error) throw error;
    if (!data.session) throw new Error('Sign in to access your saved dashboard data.');
    return data.session.user;
  }

  function refreshRecords() {
    const request = refreshQueue.catch(() => {}).then(async () => {
      while (true) {
        const revision = recordRevision;
        const userId = activeUserId;
        const records = [];
        const pageSize = 1000;
        for (let offset = 0; ; offset += pageSize) {
          const { data, error } = await getClient()
            .from('dashboard_records')
            .select('id, record')
            .order('created_at', { ascending: true })
            .range(offset, offset + pageSize - 1);
          if (error) throw error;
          records.push(...data.map(toRecord));
          if (data.length < pageSize) break;
        }
        if (revision !== recordRevision || userId !== activeUserId) continue;
        if (!userId) {
          callbacks.forEach(callback => callback(records));
          return;
        }
        let state;
        try {
          state = await updateOfflineState(userId, current => ({ ...current, records }));
        } catch (error) {
          if (revision !== recordRevision || userId !== activeUserId) continue;
          setSyncStatus(`Offline cache unavailable: ${errorMessage(error)}`);
          callbacks.forEach(callback => callback(records));
          return;
        }
        if (revision !== recordRevision || userId !== activeUserId) continue;
        callbacks.forEach(callback => callback(applyPendingRecords(records, state.pending)));
        return;
      }
    });
    refreshQueue = request;
    return request;
  }

  function errorMessage(error) {
    return error instanceof Error ? error.message : error?.message || String(error);
  }

  function reportRefreshFailure(error) {
    setSyncStatus(`Refresh failed: ${errorMessage(error)}`);
  }

  function reportWriteFailure(error) {
    setSyncStatus(`Save failed: ${errorMessage(error)}`);
    return { isOk: false, error };
  }

  function isNetworkError(error) {
    return !navigator.onLine || error instanceof TypeError ||
      error?.name === 'AbortError' ||
      /failed to fetch|network request failed|load failed|networkerror/i.test(errorMessage(error));
  }

  function applyPendingRecords(records, pending) {
    const visible = new Map(records.map(record => [record.__backendId, record]));
    for (const operation of pending) {
      if (operation.type === 'delete') {
        visible.delete(operation.id);
      } else {
        visible.set(operation.id, operation.record);
      }
    }
    return [...visible.values()];
  }

  async function publishOfflineState(userId) {
    const state = await readOfflineState(userId);
    callbacks.forEach(callback => callback(applyPendingRecords(state.records, state.pending)));
    return state;
  }

  async function queueOfflineOperation(userId, operation) {
    const state = await updateOfflineState(userId, current => {
      const pending = [...current.pending];
      if (operation.type === 'update') {
        let existing = -1;
        for (let index = pending.length - 1; index >= 0; index--) {
          if (pending[index].type === 'update' && pending[index].id === operation.id) {
            existing = index;
            break;
          }
        }
        if (existing >= 0) pending[existing] = operation;
        else pending.push(operation);
      } else {
        pending.push(operation);
      }
      return { ...current, pending };
    });
    await publishOfflineState(userId);
    setSyncStatus(`Saved on this device — ${state.pending.length} change${state.pending.length === 1 ? '' : 's'} waiting for internet`);
    return { isOk: true, queued: true };
  }

  async function sendOperation(userId, operation) {
    const table = getClient().from('dashboard_records');
    if (operation.type === 'create') {
      const { data, error } = await table.insert({ user_id: userId, record: operation.record }).select('id').single();
      if (error) throw error;
      return data.id;
    }
    if (operation.type === 'update') {
      const { data, error } = await table.update({ record: operation.record }).eq('id', operation.id)
        .eq('user_id', userId).select('id').maybeSingle();
      if (error) throw error;
      if (!data) throw new Error('The saved record no longer exists.');
      return operation.id;
    }
    const { data, error } = await table.delete().eq('id', operation.id)
      .eq('user_id', userId).select('id').maybeSingle();
    if (error) throw error;
    if (!data) throw new Error('The saved record no longer exists.');
    return operation.id;
  }

  function recordPayload(record) {
    const payload = { ...record };
    delete payload.__backendId;
    return payload;
  }

  function flushPendingWrites(userId) {
    if (syncPromise) return syncPromise;
    syncPromise = serializeWrite(async () => {
      if (!navigator.onLine) return;
      let state = await readOfflineState(userId);
      while (state.pending.length && navigator.onLine) {
        const operation = state.pending[0];
        try {
          const remoteId = await sendOperation(userId, operation);
          recordRevision++;
          state = await updateOfflineState(userId, current => {
            let records = [...current.records];
            let pending = current.pending.slice(1);
            if (operation.type === 'create') {
              records = records.filter(record => record.__backendId !== remoteId);
              records.push({ ...operation.record, __backendId: remoteId });
              pending = pending.map(item => item.id === operation.id
                ? { ...item, id: remoteId, record: item.record ? { ...item.record, __backendId: remoteId } : undefined }
                : item);
            } else if (operation.type === 'update') {
              records = records.map(record => record.__backendId === operation.id ? operation.record : record);
            } else {
              records = records.filter(record => record.__backendId !== operation.id);
            }
            return { ...current, records, pending };
          });
          callbacks.forEach(callback => callback(applyPendingRecords(state.records, state.pending)));
        } catch (error) {
          if (isNetworkError(error)) {
            setSyncStatus(`Offline — ${state.pending.length} change${state.pending.length === 1 ? '' : 's'} waiting for internet`);
          } else {
            setSyncStatus(`Sync failed: ${errorMessage(error)}`);
          }
          return;
        }
        state = await readOfflineState(userId);
      }
      if (state.pending.length === 0) {
        try {
          await refreshRecords();
          setSyncStatus('Live sync connected', true);
        } catch (error) {
          setSyncStatus(`Synced, but refresh failed: ${errorMessage(error)}`);
        }
      }
    }).catch(reportRefreshFailure).finally(() => { syncPromise = null; });
    return syncPromise;
  }

  function subscribeToChanges(userId) {
    if (realtimeChannel && activeUserId === userId) return;
    if (realtimeChannel) getClient().removeChannel(realtimeChannel);
    if (activeUserId !== userId) recordRevision++;
    activeUserId = userId;
    realtimeChannel = getClient()
      .channel(`dashboard-records-${userId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'dashboard_records',
        filter: `user_id=eq.${userId}`
      }, () => {
        recordRevision++;
        refreshRecords().catch(reportRefreshFailure);
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          setSyncStatus('Live sync connected', true);
          refreshRecords().catch(reportRefreshFailure);
          flushPendingWrites(userId);
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setSyncStatus(navigator.onLine ? 'Reconnecting to live sync…' : 'Offline — reconnecting when online');
        }
      });
  }

  window.addEventListener('online', () => {
    if (!activeUserId) return;
    setSyncStatus('Reconnecting to live sync…');
    flushPendingWrites(activeUserId).then(() => refreshRecords()).catch(reportRefreshFailure);
  });
  window.addEventListener('offline', () => {
    if (!activeUserId) return;
    publishOfflineState(activeUserId).then(state => {
      setSyncStatus(`Offline — ${state.pending.length} change${state.pending.length === 1 ? '' : 's'} waiting for internet`);
    }).catch(reportRefreshFailure);
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !activeUserId) return;
    flushPendingWrites(activeUserId).then(() => refreshRecords()).catch(reportRefreshFailure);
  });

  async function saveRecord(record, id) {
    try {
      const user = await getCurrentUser();
      const localId = id || `offline-${crypto.randomUUID()}`;
      const payload = recordPayload({ ...record, __backendId: localId });
      const operation = id
        ? { type: 'update', id, record: { ...payload, __backendId: id } }
        : { type: 'create', id: localId, record: { ...payload, __backendId: localId } };
      if (!navigator.onLine) {
        return await serializeWrite(() => queueOfflineOperation(user.id, operation));
      }
      let currentState;
      try {
        currentState = await readOfflineState(user.id);
      } catch (error) {
        setSyncStatus(`Offline cache unavailable: ${errorMessage(error)}`);
        currentState = { pending: [] };
      }
      if (currentState.pending.length) {
        const result = await serializeWrite(() => queueOfflineOperation(user.id, operation));
        flushPendingWrites(user.id);
        return result;
      }
      let resultId;
      try {
        resultId = await sendOperation(user.id, operation);
      } catch (error) {
        if (isNetworkError(error)) {
          return await serializeWrite(() => queueOfflineOperation(user.id, operation));
        }
        return reportWriteFailure(error);
      }
      recordRevision++;
      setSyncStatus('Saved to Supabase', true);
      try {
        await updateOfflineState(user.id, state => {
          const records = state.records.filter(saved => saved.__backendId !== resultId);
          if (operation.type === 'create') records.push({ ...operation.record, __backendId: resultId });
          else records.push(operation.record);
          return { ...state, records };
        });
      } catch (error) {
        setSyncStatus(`Saved to Supabase, but offline cache failed: ${errorMessage(error)}`);
      }
      try {
        await refreshRecords();
      } catch (error) {
        setSyncStatus(`Saved to Supabase, but refresh failed: ${errorMessage(error)}`);
      }
      return { isOk: true };
    } catch (error) {
      return reportWriteFailure(error);
    }
  }

  window.dataSdk = {
    async init({ onDataChanged }) {
      if (typeof onDataChanged !== 'function') {
        return { isOk: false, error: new Error('A data change callback is required.') };
      }
      callbacks.add(onDataChanged);
      try {
        const user = await getCurrentUser();
        subscribeToChanges(user.id);
        try {
          await refreshRecords();
        } catch (error) {
          if (!isNetworkError(error)) throw error;
          const state = await publishOfflineState(user.id);
          setSyncStatus(`Offline — ${state.pending.length} change${state.pending.length === 1 ? '' : 's'} waiting for internet`);
        }
        flushPendingWrites(user.id);
        return { isOk: true };
      } catch (error) {
        return { isOk: false, error };
      }
    },
    async create(record) {
      return saveRecord(record);
    },
    async update(record) {
      if (!record.__backendId) {
        return reportWriteFailure(new Error('The saved record ID is missing.'));
      }
      return saveRecord(record, record.__backendId);
    },
    async delete(record) {
      if (!record.__backendId) {
        return reportWriteFailure(new Error('The saved record ID is missing.'));
      }
      try {
        const user = await getCurrentUser();
        const operation = { type: 'delete', id: record.__backendId };
        if (!navigator.onLine) {
          return await serializeWrite(() => queueOfflineOperation(user.id, operation));
        }
        let currentState;
        try {
          currentState = await readOfflineState(user.id);
        } catch (error) {
          setSyncStatus(`Offline cache unavailable: ${errorMessage(error)}`);
          currentState = { pending: [] };
        }
        if (currentState.pending.length) {
          const result = await serializeWrite(() => queueOfflineOperation(user.id, operation));
          flushPendingWrites(user.id);
          return result;
        }
        try {
          await sendOperation(user.id, operation);
        } catch (error) {
          if (isNetworkError(error)) {
            return await serializeWrite(() => queueOfflineOperation(user.id, operation));
          }
          return reportWriteFailure(error);
        }
        recordRevision++;
        setSyncStatus('Saved to Supabase', true);
        try {
          await updateOfflineState(user.id, state => ({
            ...state,
            records: state.records.filter(saved => saved.__backendId !== operation.id)
          }));
        } catch (error) {
          setSyncStatus(`Saved to Supabase, but offline cache failed: ${errorMessage(error)}`);
        }
        try {
          await refreshRecords();
        } catch (error) {
          setSyncStatus(`Saved to Supabase, but refresh failed: ${errorMessage(error)}`);
        }
        return { isOk: true };
      } catch (error) {
        return reportWriteFailure(error);
      }
    },
    async signInWithPassword(email, password) {
      try {
        const { error } = await getClient().auth.signInWithPassword({ email, password });
        return { isOk: !error, error };
      } catch (error) {
        return { isOk: false, error };
      }
    },
    async requestPasswordReset(email) {
      try {
        const { error } = await getClient().auth.resetPasswordForEmail(email, {
          redirectTo: `${location.origin}${location.pathname}`
        });
        return { isOk: !error, error };
      } catch (error) {
        return { isOk: false, error };
      }
    },
    async updatePassword(password) {
      try {
        const { error } = await getClient().auth.updateUser({ password });
        return { isOk: !error, error };
      } catch (error) {
        return { isOk: false, error };
      }
    },
    onAuthStateChange(callback) {
      try {
        const { data: { subscription } } = getClient().auth.onAuthStateChange(callback);
        return { isOk: true, subscription };
      } catch (error) {
        return { isOk: false, error };
      }
    },
    async signOut() {
      try {
        const { error } = await getClient().auth.signOut();
        return { isOk: !error, error };
      } catch (error) {
        return { isOk: false, error };
      }
    },
    async getSession() {
      try {
        const { data, error } = await getClient().auth.getSession();
        return { isOk: !error, session: data?.session || null, error };
      } catch (error) {
        return { isOk: false, session: null, error };
      }
    }
  };

  function createDashboardSidebar(currentPage) {
    const pages = [
      { id: 1, title: 'Dashboard' },
      { id: 2, title: 'Week At A Glance' },
      { id: 6, title: 'Week in Depth' },
      { id: 3, title: 'Habit Tracker' },
      { id: 4, title: 'Monthly Spending' },
      { id: 5, title: 'Book Tracker' }
    ];
    const sidebar = document.createElement('aside');
    sidebar.className = 'dashboard-sidebar';

    const brand = document.createElement('div');
    brand.className = 'dashboard-brand';
    brand.textContent = 'daymark.';

    const nav = document.createElement('nav');
    nav.setAttribute('aria-label', 'Dashboard pages');
    pages.filter(page => page.id !== currentPage).forEach(page => {
      const link = document.createElement('a');
      link.className = 'dashboard-page-link';
      link.href = `#page-${page.id}`;
      link.textContent = page.title;
      nav.appendChild(link);
    });

    const signOut = document.createElement('button');
    signOut.type = 'button';
    signOut.className = 'dashboard-sign-out sign-out';
    signOut.hidden = true;
    signOut.textContent = 'Sign out';

    const note = document.createElement('p');
    note.className = 'dashboard-sidebar-note';
    note.textContent = 'A little clarity for everything on your plate.';

    sidebar.append(brand, nav, signOut, note);
    const syncStatus = document.createElement('p');
    syncStatus.className = 'dashboard-sync-status';
    syncStatus.setAttribute('role', 'status');
    syncStatus.setAttribute('aria-live', 'polite');
    syncStatus.textContent = 'Connecting to live sync…';
    sidebar.insertBefore(syncStatus, note);
    return sidebar;
  }

  function setupDashboardNavigation() {
    for (const pageNumber of [1, 2, 3, 4, 5, 6]) {
      const page = document.getElementById(`page-${pageNumber}`);
      if (!page) continue;

      let layout = page;
      if (pageNumber === 1) {
        layout = page.parentElement;
        if (!layout) continue;
        layout.querySelector(':scope > aside')?.remove();
      } else if (pageNumber === 6) {
        page.querySelector(':scope > aside')?.remove();
      } else {
        const content = document.createElement('div');
        content.className = 'dashboard-page-content';
        if (pageNumber === 2) {
          for (const className of ['px-4', 'py-7', 'md:px-9', 'md:py-10']) {
            if (page.classList.contains(className)) {
              content.classList.add(className);
              page.classList.remove(className);
            }
          }
        }
        while (page.firstChild) content.appendChild(page.firstChild);
        page.appendChild(content);
      }

      layout.classList.add('dashboard-layout');
      layout.prepend(createDashboardSidebar(pageNumber));
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    setupDashboardNavigation();
    const gate = document.getElementById('auth-gate');
    const form = document.getElementById('auth-form');
    const resetRequestForm = document.getElementById('password-reset-request-form');
    const newPasswordForm = document.getElementById('new-password-form');
    const status = document.getElementById('auth-status');
    const submit = document.getElementById('auth-submit');
    const signOutButtons = [...document.querySelectorAll('.sign-out')];
    if (!gate || !form || !resetRequestForm || !newPasswordForm || !status || !submit || !signOutButtons.length) return;
    let passwordRecovery = false;

    function showAuthForm(mode) {
      gate.hidden = false;
      form.hidden = mode !== 'login';
      resetRequestForm.hidden = mode !== 'request-reset';
      newPasswordForm.hidden = mode !== 'set-password';
      status.textContent = '';
      document.getElementById('auth-heading').textContent =
        mode === 'set-password' ? 'Choose a new password' :
        mode === 'request-reset' ? 'Reset your password' :
        'Sign in to save your data';
      document.getElementById('auth-description').textContent =
        mode === 'set-password' ? 'Choose a new password for your dashboard account.' :
        mode === 'request-reset' ? 'Enter your account email and we’ll send a password reset link.' :
        'Sign in with your email and password. Your dashboard data is private to your account.';
    }

    const authState = window.dataSdk.onAuthStateChange(event => {
      if (event === 'PASSWORD_RECOVERY') {
        passwordRecovery = true;
        showAuthForm('set-password');
      }
    });
    if (!authState.isOk) {
      status.textContent = `Could not initialize password recovery: ${authState.error.message}`;
    }

    try {
      getClient();
      const sessionResult = await window.dataSdk.getSession();
      if (!sessionResult.isOk) throw sessionResult.error;
      if (sessionResult.session && !passwordRecovery) {
        gate.hidden = true;
        signOutButtons.forEach(button => { button.hidden = false; });
        status.textContent = `Signed in as ${sessionResult.session.user.email}.`;
      } else {
        showAuthForm(passwordRecovery ? 'set-password' : 'login');
      }
    } catch (error) {
      showAuthForm('login');
      status.textContent = error.message;
      form.hidden = true;
      const config = window.SUPABASE_CONFIG || {};
      document.getElementById('auth-description').textContent = config.url && config.anonKey
        ? 'Supabase could not be reached. Check the message above, then reload the page.'
        : 'Set up the Supabase project and database before signing in. Follow the steps in SUPABASE_SETUP.md.';
    }

    form.addEventListener('submit', async event => {
      event.preventDefault();
      submit.disabled = true;
      status.textContent = 'Signing in…';
      const result = await window.dataSdk.signInWithPassword(
        document.getElementById('auth-email').value.trim(),
        document.getElementById('auth-password').value
      );
      if (result.isOk) {
        status.textContent = 'Signed in. Loading your dashboard…';
        location.reload();
      } else {
        status.textContent = `Could not sign in: ${result.error.message}`;
        submit.disabled = false;
      }
    });

    document.getElementById('forgot-password').addEventListener('click', () => {
      document.getElementById('reset-email').value = document.getElementById('auth-email').value.trim();
      showAuthForm('request-reset');
    });
    document.getElementById('back-to-login-from-reset').addEventListener('click', () => showAuthForm('login'));
    document.getElementById('back-to-login-from-password').addEventListener('click', async () => {
      passwordRecovery = false;
      await window.dataSdk.signOut();
      showAuthForm('login');
    });
    resetRequestForm.addEventListener('submit', async event => {
      event.preventDefault();
      const email = document.getElementById('reset-email').value.trim();
      const resetSubmit = document.getElementById('reset-submit');
      resetSubmit.disabled = true;
      status.textContent = 'Sending password reset email…';
      const result = await window.dataSdk.requestPasswordReset(email);
      status.textContent = result.isOk
        ? 'If an account exists for that email, a password reset link has been sent.'
        : `Could not send the reset email: ${result.error.message}`;
      resetSubmit.disabled = false;
    });
    newPasswordForm.addEventListener('submit', async event => {
      event.preventDefault();
      const password = document.getElementById('new-password').value;
      const confirmation = document.getElementById('confirm-password').value;
      if (password !== confirmation) {
        status.textContent = 'The passwords do not match.';
        return;
      }
      const passwordSubmit = document.getElementById('new-password-submit');
      passwordSubmit.disabled = true;
      status.textContent = 'Updating your password…';
      const result = await window.dataSdk.updatePassword(password);
      if (!result.isOk) {
        status.textContent = `Could not update your password: ${result.error.message}`;
        passwordSubmit.disabled = false;
        return;
      }
      const signOutResult = await window.dataSdk.signOut();
      if (!signOutResult.isOk) {
        status.textContent = 'Password updated. Reload this page, then sign in with your new password.';
        passwordSubmit.disabled = false;
        return;
      }
      passwordRecovery = false;
      status.textContent = 'Password updated. Sign in with your new password.';
      location.replace(`${location.pathname}${location.search}`);
    });

    signOutButtons.forEach(signOut => signOut.addEventListener('click', async () => {
      signOut.disabled = true;
      const result = await window.dataSdk.signOut();
      if (!result.isOk) {
        status.textContent = `Could not sign out: ${result.error.message}`;
        signOut.disabled = false;
        return;
      }
      location.reload();
    }));
  });
})();
