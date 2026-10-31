(() => {
  const callbacks = new Set();
  let client;
  let activeUserId;
  let realtimeChannel;

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
      .subscribe();
  }

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
    async sendSignInLink(email) {
      try {
        const { error } = await getClient().auth.signInWithOtp({
          email,
          options: { emailRedirectTo: `${location.origin}${location.pathname}` }
        });
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

  document.addEventListener('DOMContentLoaded', async () => {
    const gate = document.getElementById('auth-gate');
    const form = document.getElementById('auth-form');
    const status = document.getElementById('auth-status');
    const submit = document.getElementById('auth-submit');
    const signOut = document.getElementById('sign-out');
    if (!gate || !form || !status || !submit || !signOut) return;

    try {
      getClient();
      const sessionResult = await window.dataSdk.getSession();
      if (!sessionResult.isOk) throw sessionResult.error;
      if (sessionResult.session) {
        gate.hidden = true;
        signOut.hidden = false;
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
      status.textContent = 'Sending sign-in link…';
      const result = await window.dataSdk.sendSignInLink(document.getElementById('auth-email').value.trim());
      status.textContent = result.isOk
        ? 'Check your email for a secure sign-in link.'
        : `Could not send sign-in link: ${result.error.message}`;
      submit.disabled = false;
    });

    signOut.addEventListener('click', async () => {
      signOut.disabled = true;
      const result = await window.dataSdk.signOut();
      if (!result.isOk) {
        status.textContent = `Could not sign out: ${result.error.message}`;
        signOut.disabled = false;
        return;
      }
      location.reload();
    });
  });
})();
