(() => {
  const config = window.SUPABASE_CONFIG || {};
  const apiBase = "https://www.googleapis.com/calendar/v3";
  const scope = "https://www.googleapis.com/auth/calendar.events";
  const listeners = new Set();
  let tokenClient;
  let accessToken = "";
  let tokenExpiresAt = 0;
  let tokenRequest;

  function notify(change) {
    for (const listener of listeners) listener(change);
  }

  function getToken() {
    if (!accessToken || Date.now() >= tokenExpiresAt) {
      accessToken = "";
      throw new Error("Google Calendar authorization expired. Connect again to continue.");
    }
    return accessToken;
  }

  function initializeTokenClient() {
    const clientId = config.googleClientId?.trim();
    if (!clientId) throw new Error("Add your Google OAuth client ID to supabase-config.js first.");
    if (!window.google?.accounts?.oauth2) {
      throw new Error("Google sign-in could not load. Check your connection and reload the page.");
    }
    if (tokenClient) return tokenClient;

    tokenClient = window.google.accounts.oauth2.initTokenClient({
      client_id: clientId,
      scope,
      callback(response) {
        if (response.error) {
          tokenRequest?.reject(new Error(response.error_description || response.error));
          tokenRequest = null;
          return;
        }
        if (!response.access_token) {
          tokenRequest?.reject(new Error("Google did not return an access token."));
          tokenRequest = null;
          return;
        }
        accessToken = response.access_token;
        tokenExpiresAt = Date.now() + (Number(response.expires_in) || 3600) * 1000 - 30000;
        tokenRequest?.resolve();
        tokenRequest = null;
        notify("connected");
      }
    });
    return tokenClient;
  }

  function requestToken(prompt) {
    const client = initializeTokenClient();
    if (tokenRequest) return tokenRequest.promise;
    let resolveRequest;
    let rejectRequest;
    const promise = new Promise((resolve, reject) => {
      resolveRequest = resolve;
      rejectRequest = reject;
    });
    tokenRequest = { promise, resolve:resolveRequest, reject:rejectRequest };
    try {
      client.requestAccessToken({ prompt });
    } catch (error) {
      tokenRequest.reject(error);
      tokenRequest = null;
    }
    return promise;
  }

  async function api(path, options = {}) {
    const response = await fetch(`${apiBase}${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${getToken()}`,
        ...(options.body ? { "Content-Type": "application/json" } : {}),
        ...options.headers
      }
    });
    if (!response.ok) {
      let message = `Google Calendar request failed (${response.status}).`;
      try {
        const body = await response.json();
        message = body.error?.message || message;
      } catch {}
      throw new Error(message);
    }
    if (response.status === 204) return null;
    return response.json();
  }

  function eventPath(eventId = "") {
    const base = "/calendars/primary/events";
    return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
  }

  window.googleCalendar = {
    isConfigured() {
      return Boolean(config.googleClientId?.trim());
    },
    isConnected() {
      return Boolean(accessToken && Date.now() < tokenExpiresAt);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    async connect() {
      if (this.isConnected()) return;
      await requestToken("consent");
    },
    disconnect() {
      const oldToken = accessToken;
      accessToken = "";
      tokenExpiresAt = 0;
      notify("disconnected");
      if (oldToken && window.google?.accounts?.oauth2) {
        window.google.accounts.oauth2.revoke(oldToken, () => {});
      }
    },
    async listEvents(timeMin, timeMax) {
      const events = [];
      let pageToken = "";
      do {
        const params = new URLSearchParams({
          singleEvents: "true",
          orderBy: "startTime",
          timeMin,
          timeMax,
          maxResults: "2500"
        });
        if (pageToken) params.set("pageToken", pageToken);
        const result = await api(`${eventPath()}?${params}`);
        events.push(...(result.items || []));
        pageToken = result.nextPageToken || "";
      } while (pageToken);
      return events;
    },
    occursOnDate(event, date) {
      const dayStart = new Date(`${date}T00:00:00`);
      const dayEnd = new Date(dayStart);
      dayEnd.setDate(dayEnd.getDate() + 1);
      const start = event.start?.date
        ? new Date(`${event.start.date}T00:00:00`)
        : new Date(event.start?.dateTime);
      const end = event.end?.date
        ? new Date(`${event.end.date}T00:00:00`)
        : new Date(event.end?.dateTime);
      return start < dayEnd && end > dayStart;
    },
    async createEvent(event) {
      const result = await api(eventPath(), { method: "POST", body: JSON.stringify(event) });
      notify("changed");
      return result;
    },
    async updateEvent(eventId, event) {
      const result = await api(eventPath(eventId), { method: "PATCH", body: JSON.stringify(event) });
      notify("changed");
      return result;
    },
    async deleteEvent(eventId) {
      await api(eventPath(eventId), { method: "DELETE" });
      notify("changed");
    }
  };
})();
