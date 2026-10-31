(() => {
  const callbacks = new Set();
  let client;
  let activeUserId;
  let realtimeChannel;

  function setSyncStatus(text, connected = false) {
    document.querySelectorAll('.dashboard-sync-status').forEach(status => {
      status.textContent = text;
      status.dataset.connected = String(connected);
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

  async function refreshRecords() {
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
    callbacks.forEach(callback => callback(records));
  }

  function subscribeToChanges(userId) {
    if (realtimeChannel && activeUserId === userId) return;
    if (realtimeChannel) getClient().removeChannel(realtimeChannel);
    activeUserId = userId;
    realtimeChannel = getClient()
      .channel(`dashboard-records-${userId}`)
      .on('postgres_changes', {
        event: '*',
        schema: 'public',
        table: 'dashboard_records',
        filter: `user_id=eq.${userId}`
      }, () => {
        refreshRecords().catch(error => {
          const status = document.getElementById('auth-status');
          if (status) status.textContent = `Could not refresh saved data: ${error.message}`;
        });
      })
      .subscribe(status => {
        if (status === 'SUBSCRIBED') {
          setSyncStatus('Live sync connected', true);
          refreshRecords().catch(() => setSyncStatus('Could not refresh saved data'));
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          setSyncStatus(navigator.onLine ? 'Reconnecting to live sync…' : 'Offline — reconnecting when online');
        }
      });
  }

  window.addEventListener('online', () => {
    if (!activeUserId) return;
    setSyncStatus('Reconnecting to live sync…');
    refreshRecords().catch(() => setSyncStatus('Could not refresh saved data'));
  });
  window.addEventListener('offline', () => {
    if (activeUserId) setSyncStatus('Offline — reconnecting when online');
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || !activeUserId) return;
    refreshRecords().catch(() => setSyncStatus('Could not refresh saved data'));
  });

  async function saveRecord(record, id) {
    const user = await getCurrentUser();
    const payload = { ...record };
    delete payload.__backendId;
    const table = getClient().from('dashboard_records');
    const response = id
      ? await table.update({ record: payload }).eq('id', id).eq('user_id', user.id).select('id').maybeSingle()
      : await table.insert({ user_id: user.id, record: payload }).select('id').single();
    const { data, error } = response;
    if (error) return { isOk: false, error };
    if (!data) return { isOk: false, error: new Error('The saved record no longer exists.') };
    await refreshRecords();
    return { isOk: true };
  }

  window.dataSdk = {
    async init({ onDataChanged }) {
      if (typeof onDataChanged !== 'function') {
        return { isOk: false, error: new Error('A data change callback is required.') };
      }
      callbacks.add(onDataChanged);
      try {
        const user = await getCurrentUser();
        await refreshRecords();
        subscribeToChanges(user.id);
        return { isOk: true };
      } catch (error) {
        return { isOk: false, error };
      }
    },
    async create(record) {
      try {
        return await saveRecord(record);
      } catch (error) {
        return { isOk: false, error };
      }
    },
    async update(record) {
      if (!record.__backendId) {
        return { isOk: false, error: new Error('The saved record ID is missing.') };
      }
      try {
        return await saveRecord(record, record.__backendId);
      } catch (error) {
        return { isOk: false, error };
      }
    },
    async delete(record) {
      if (!record.__backendId) {
        return { isOk: false, error: new Error('The saved record ID is missing.') };
      }
      try {
        const user = await getCurrentUser();
        const { data, error } = await getClient()
          .from('dashboard_records')
          .delete()
          .eq('id', record.__backendId)
          .eq('user_id', user.id)
          .select('id')
          .maybeSingle();
        if (error) return { isOk: false, error };
        if (!data) return { isOk: false, error: new Error('The saved record no longer exists.') };
        await refreshRecords();
        return { isOk: true };
      } catch (error) {
        return { isOk: false, error };
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
      { id: 4, title: 'Quarterly Finance' },
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
    const status = document.getElementById('auth-status');
    const submit = document.getElementById('auth-submit');
    const signOutButtons = [...document.querySelectorAll('.sign-out')];
    if (!gate || !form || !status || !submit || !signOutButtons.length) return;

    try {
      getClient();
      const sessionResult = await window.dataSdk.getSession();
      if (!sessionResult.isOk) throw sessionResult.error;
      if (sessionResult.session) {
        gate.hidden = true;
        signOutButtons.forEach(button => { button.hidden = false; });
        status.textContent = `Signed in as ${sessionResult.session.user.email}.`;
      } else {
        gate.hidden = false;
      }
    } catch (error) {
      gate.hidden = false;
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
