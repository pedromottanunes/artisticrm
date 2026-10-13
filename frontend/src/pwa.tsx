import { useEffect, useState } from 'react';
import { Bell, BellOff, Download, Send, Volume2, VolumeX } from 'lucide-react';
import { api } from './api';
import {
  soundEnabled,
  setSoundEnabled,
  prepareNotificationSound,
  playNotificationSound,
} from './notification-sound';

type InstallEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: string }>;
};
let installPrompt: InstallEvent | null = null;
let worker: Promise<ServiceWorkerRegistration | undefined> | undefined;
let reconciliation: { key: string; promise: Promise<boolean> } | undefined;
type PushConfig = { enabled: boolean; publicKey: string | null };
type DeviceStatus = {
  userId: string;
  config?: PushConfig;
  subscribed?: boolean;
  permission: NotificationPermission;
  error?: string;
};
const publishDeviceStatus = (status: Omit<DeviceStatus, 'permission'>) => {
  window.dispatchEvent(
    new CustomEvent<DeviceStatus>('artisti-push-status', {
      detail: {
        ...status,
        permission: 'Notification' in window ? Notification.permission : 'default',
      },
    }),
  );
};
const deviceChecks = new Map<string, Promise<boolean>>();
function checkDevicePush(userId: string): Promise<boolean> {
  const pending = deviceChecks.get(userId);
  if (pending) return pending;
  const check = (async () => {
    let config: PushConfig | undefined;
    try {
      config = await api<PushConfig>('/push/config', { signal: AbortSignal.timeout(20_000) });
      const subscribed = config.enabled && (await reconcileDevicePush(userId, config.publicKey));
      publishDeviceStatus({ userId, config, subscribed });
      return true;
    } catch {
      publishDeviceStatus({
        userId,
        config,
        error:
          'Não foi possível verificar as notificações. O CRM tentará novamente automaticamente.',
      });
      return false;
    } finally {
      deviceChecks.delete(userId);
    }
  })();
  deviceChecks.set(userId, check);
  return check;
}
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event as InstallEvent;
  window.dispatchEvent(new Event('artisti-install'));
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  window.dispatchEvent(new Event('artisti-install'));
});
export async function registerDeviceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return undefined;
  worker ??= navigator.serviceWorker
    .register('/sw.js', { updateViaCache: 'none' })
    .then(async (registration) => {
      // Initial installation finishes before the user can subscribe. A failed install
      // must not leave the activation button pending forever.
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return (
          (await Promise.race([
            navigator.serviceWorker.ready,
            new Promise<undefined>((resolve) => {
              timeout = setTimeout(() => resolve(undefined), 15000);
            }),
          ])) ?? registration
        );
      } finally {
        if (timeout) clearTimeout(timeout);
      }
    })
    .catch(() => undefined);
  const registration = await worker;
  if (!registration) worker = undefined;
  return registration;
}
const installed = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const ios = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
async function disconnectPush() {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager?.getSubscription();
  if (subscription) {
    // Either side is enough to stop delivery. Attempt both so a transient API
    // failure cannot leave the browser subscription active.
    const [server, browser] = await Promise.allSettled([
      api('/push/subscriptions', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
        signal: AbortSignal.timeout(20_000),
      }),
      subscription.unsubscribe(),
    ]);
    const stoppedOnServer = server.status === 'fulfilled';
    const stoppedInBrowser = browser.status === 'fulfilled' && browser.value === true;
    if (!stoppedOnServer && !stoppedInBrowser)
      throw server.status === 'rejected'
        ? server.reason
        : browser.status === 'rejected'
          ? browser.reason
          : new Error('Não foi possível desativar as notificações neste aparelho.');
  }
}
const optOutKey = (userId: string) => `artisti-push-opt-out:${userId}`;
const temporaryOptOut = new Map<string, boolean>();
const optedOut = (userId: string) => {
  if (temporaryOptOut.has(userId)) return temporaryOptOut.get(userId)!;
  try {
    return localStorage.getItem(optOutKey(userId)) === 'true';
  } catch {
    return false;
  }
};
const setOptedOut = (userId: string, value: boolean) => {
  try {
    if (value) localStorage.setItem(optOutKey(userId), 'true');
    else localStorage.removeItem(optOutKey(userId));
    temporaryOptOut.delete(userId);
  } catch {
    // Keep the explicit choice for this page even when storage is unavailable.
    // A false value must also override an older, persisted opt-out.
    temporaryOptOut.set(userId, value);
  }
};
const subscriptionKey = (subscription: PushSubscription) =>
  subscription.options.applicationServerKey
    ? btoa(String.fromCharCode(...new Uint8Array(subscription.options.applicationServerKey)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    : '';
const publicKeyBytes = (publicKey: string) =>
  Uint8Array.from(atob(publicKey.replace(/-/g, '+').replace(/_/g, '/')), (char) =>
    char.charCodeAt(0),
  );
async function reconcileDevicePush(userId: string, publicKey: string | null): Promise<boolean> {
  if (
    !publicKey ||
    optedOut(userId) ||
    !('Notification' in window) ||
    !('PushManager' in window) ||
    !('serviceWorker' in navigator) ||
    !window.isSecureContext ||
    Notification.permission !== 'granted'
  )
    return false;
  const key = `${userId}:${publicKey}`;
  if (reconciliation?.key === key) return reconciliation.promise;
  if (reconciliation) {
    try {
      await reconciliation.promise;
    } catch {
      /* A new reconciliation still gets its own attempt. */
    }
    return reconcileDevicePush(userId, publicKey);
  }
  const promise = (async () => {
    const registration = await registerDeviceWorker();
    if (!registration?.active)
      throw new Error('O serviço de notificações ainda não está disponível.');
    let subscription = await registration.pushManager.getSubscription();
    if (subscription && subscriptionKey(subscription) !== publicKey) {
      await subscription.unsubscribe();
      subscription = null;
    }
    // Permission was already granted by the user. Recreate a lost browser
    // subscription without asking for the same permission again.
    subscription ??= await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: publicKeyBytes(publicKey),
    });
    if (optedOut(userId)) return false;
    await api('/push/subscriptions', {
      method: 'POST',
      body: JSON.stringify(subscription.toJSON()),
      signal: AbortSignal.timeout(20_000),
    });
    return true;
  })();
  reconciliation = { key, promise };
  try {
    return await promise;
  } finally {
    if (reconciliation?.promise === promise) reconciliation = undefined;
  }
}
export function PushBinding({ userId }: { userId: string }) {
  useEffect(() => {
    const seen = new Set<string>();
    const unlock = () => {
      if (soundEnabled(userId)) void prepareNotificationSound();
    };
    const receive = (event: MessageEvent) => {
      const value = event.data;
      const reply = (handled: boolean) => event.ports?.[0]?.postMessage({ handled });
      if (
        value?.type !== 'artisti-push' ||
        value.userId !== userId ||
        typeof value.tag !== 'string' ||
        document.hidden ||
        (typeof value.soundDeadline === 'number' && Date.now() >= value.soundDeadline)
      ) {
        reply(false);
        return;
      }
      // Explicit mute and already-handled retries must stay silent. Otherwise,
      // let the worker fall back to OS sound when Web Audio cannot play.
      const handled = seen.has(value.tag) || !soundEnabled(userId) || playNotificationSound();
      if (handled) {
        seen.add(value.tag);
        if (seen.size > 200) seen.delete(seen.values().next().value!);
      }
      reply(handled);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    navigator.serviceWorker?.addEventListener('message', receive);
    return () => {
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      navigator.serviceWorker?.removeEventListener('message', receive);
    };
  }, [userId]);
  useEffect(() => {
    let disposed = false;
    let checking = false;
    let lastCheck = 0;
    let pendingRepair = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let retryDelay = 15_000;
    const statusChanged = (event: Event) => {
      const status = (event as CustomEvent<DeviceStatus>).detail;
      if (disposed || status.userId !== userId) return;
      if (status.error) {
        if (retry === undefined) {
          retry = setTimeout(() => {
            retry = undefined;
            void repair(true);
          }, retryDelay);
          retryDelay = Math.min(retryDelay * 2, 60_000);
        }
      } else {
        clearTimeout(retry);
        retry = undefined;
        lastCheck = Date.now();
        retryDelay = 15_000;
      }
    };
    const repair = async (force = false) => {
      if (disposed) return;
      if (checking) {
        pendingRepair ||= force;
        return;
      }
      if (!force && Date.now() - lastCheck < 60_000) return;
      clearTimeout(retry);
      retry = undefined;
      checking = true;
      try {
        await checkDevicePush(userId);
      } finally {
        checking = false;
        if (!disposed && pendingRepair) {
          pendingRepair = false;
          void repair(true);
        }
      }
    };
    const resume = () => {
      if (!document.hidden) void repair();
    };
    const workerReady = () => void repair(true);
    window.addEventListener('artisti-push-status', statusChanged);
    void repair(true);
    const timer = window.setInterval(() => void repair(true), 6 * 60 * 60_000);
    window.addEventListener('focus', resume);
    window.addEventListener('online', workerReady);
    document.addEventListener('visibilitychange', resume);
    navigator.serviceWorker?.addEventListener('controllerchange', workerReady);
    return () => {
      disposed = true;
      window.clearInterval(timer);
      clearTimeout(retry);
      window.removeEventListener('artisti-push-status', statusChanged);
      window.removeEventListener('focus', resume);
      window.removeEventListener('online', workerReady);
      document.removeEventListener('visibilitychange', resume);
      navigator.serviceWorker?.removeEventListener('controllerchange', workerReady);
    };
  }, [userId]);
  return null;
}
export function DevicePanel({ userId }: { userId: string }) {
  const [config, setConfig] = useState<{ enabled: boolean; publicKey: string | null }>();
  const [isInstalled, setInstalled] = useState(installed);
  const [canInstall, setCanInstall] = useState(!!installPrompt);
  const [subscribed, setSubscribed] = useState(false);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verificationError, setVerificationError] = useState('');
  const [notice, setNotice] = useState('');
  const [audible, setAudible] = useState(() => soundEnabled(userId));
  useEffect(() => {
    const update = () => setAudible(soundEnabled(userId));
    update();
    window.addEventListener('artisti-sound-preference', update);
    window.addEventListener('storage', update);
    return () => {
      window.removeEventListener('artisti-sound-preference', update);
      window.removeEventListener('storage', update);
    };
  }, [userId]);
  const supported =
    'Notification' in window &&
    'PushManager' in window &&
    'serviceWorker' in navigator &&
    window.isSecureContext;
  const [permission, setPermission] = useState(supported ? Notification.permission : 'default');
  useEffect(() => {
    let disposed = false;
    const change = () => {
      setInstalled(installed());
      setCanInstall(!!installPrompt);
    };
    window.addEventListener('artisti-install', change);
    const update = (event: Event) => {
      const status = (event as CustomEvent<DeviceStatus>).detail;
      if (disposed || status.userId !== userId) return;
      if (status.config) setConfig(status.config);
      setPermission(status.permission);
      if (status.subscribed !== undefined) setSubscribed(status.subscribed);
      setVerificationError(status.error ?? '');
      setChecking(false);
    };
    window.addEventListener('artisti-push-status', update);
    setChecking(true);
    void checkDevicePush(userId);
    return () => {
      disposed = true;
      window.removeEventListener('artisti-install', change);
      window.removeEventListener('artisti-push-status', update);
    };
  }, [userId]);
  const enable = async () => {
    if (busy || !config?.publicKey) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      // Safari requires the permission prompt directly inside the tap handler.
      const permissionRequest = Notification.requestPermission();
      if (soundEnabled(userId)) void prepareNotificationSound();
      const allowed = await permissionRequest;
      setPermission(allowed);
      if (allowed !== 'granted') return;
      setOptedOut(userId, false);
      const bound = await reconcileDevicePush(userId, config.publicKey);
      if (!bound)
        throw new Error(
          'A instalação ainda está sendo preparada. Tente novamente em alguns segundos.',
        );
      setSubscribed(true);
      publishDeviceStatus({ userId, config, subscribed: true });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const action = async (test: boolean) => {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (test) {
        const registration = await navigator.serviceWorker.getRegistration('/');
        const subscription = await registration?.pushManager.getSubscription();
        if (!subscription) throw new Error('Ative as notificações novamente.');
        await api('/push/test', {
          method: 'POST',
          body: JSON.stringify({ endpoint: subscription.endpoint }),
        });
        setNotice('Teste colocado na fila. Aguarde a notificação neste aparelho.');
      } else {
        const previouslyOptedOut = optedOut(userId);
        setOptedOut(userId, true);
        try {
          if (reconciliation) await reconciliation.promise.catch(() => false);
          await disconnectPush();
          setSubscribed(false);
          publishDeviceStatus({ userId, config, subscribed: false });
        } catch (disableError) {
          // A check started during the disable attempt can publish the temporary
          // opt-out. Let it finish before restoring and rechecking the real state.
          await deviceChecks.get(userId);
          setOptedOut(userId, previouslyOptedOut);
          await checkDevicePush(userId);
          throw disableError;
        }
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="device-options">
      {isInstalled ? (
        <p className="device-state">CRM instalado neste aparelho</p>
      ) : (
        <>
          <p>Adicione o CRM à Tela de Início para abrir como aplicativo.</p>
          {canInstall ? (
            <button
              className="button gold"
              disabled={busy}
              onClick={async () => {
                const prompt = installPrompt;
                if (!prompt) return;
                try {
                  await prompt.prompt();
                  await prompt.userChoice;
                  installPrompt = null;
                  setCanInstall(false);
                  setInstalled(installed());
                } catch {
                  setError('Use o menu do navegador para adicionar o aplicativo à Tela de Início.');
                }
              }}
            >
              <Download size={18} />
              Instalar aplicativo
            </button>
          ) : (
            <ol>
              <li>{ios() ? 'No Safari, toque em Compartilhar.' : 'Abra o menu do navegador.'}</li>
              <li>Escolha “Adicionar à Tela de Início” ou “Instalar aplicativo”.</li>
              <li>Abra o CRM pelo novo ícone.</li>
            </ol>
          )}
        </>
      )}
      {ios() && !isInstalled ? (
        <p>
          No iPhone, abra pelo ícone da Tela de Início para ativar notificações (iOS 16.4 ou
          posterior).
        </p>
      ) : !supported ? (
        <p>Este navegador não oferece notificações push. Use um navegador atualizado.</p>
      ) : verificationError ? (
        <p role="status">{verificationError}</p>
      ) : !config || checking ? (
        <p>Consultando notificações…</p>
      ) : !config.enabled ? (
        <p>Notificações aguardam ativação pela gestão. Acompanhe os leads com o CRM aberto.</p>
      ) : permission === 'denied' ? (
        <p>
          Notificações bloqueadas. Libere os avisos nas configurações deste aplicativo ou navegador
          e reabra o CRM.
        </p>
      ) : subscribed ? (
        <>
          <p className="device-state">Notificações ativadas neste aparelho</p>
          <div className="device-actions">
            <button className="button outline" disabled={busy} onClick={() => void action(true)}>
              <Send size={18} />
              Testar aviso
            </button>
            <button className="button outline" disabled={busy} onClick={() => void action(false)}>
              <BellOff size={18} />
              Desativar
            </button>
          </div>
        </>
      ) : (
        <button className="button gold" disabled={busy} onClick={() => void enable()}>
          <Bell size={18} />
          {busy ? 'Ativando…' : 'Ativar notificações'}
        </button>
      )}
      <div className="device-actions">
        <button
          type="button"
          className="button outline"
          aria-pressed={audible}
          onClick={() => {
            setSoundEnabled(userId, !audible);
            if (!audible) void prepareNotificationSound();
          }}
        >
          {audible ? <VolumeX size={18} /> : <Volume2 size={18} />}
          {audible ? 'Silenciar som no CRM' : 'Ativar som no CRM'}
        </button>
        <button
          type="button"
          className="button outline"
          onClick={async () => {
            const ready = await prepareNotificationSound();
            setNotice(
              ready && playNotificationSound()
                ? 'Som de teste reproduzido. Confira o volume do aparelho.'
                : 'Não foi possível tocar o som. Confira as permissões de áudio do navegador.',
            );
          }}
        >
          <Volume2 size={18} /> Testar som
        </button>
      </div>
      <p>
        O alerta sonoro toca com o CRM aberto, após sua primeira interação. Com o aplicativo
        fechado, o som do push depende do aparelho e do modo silencioso.
      </p>
      <p>
        Os avisos incluem cada nova mensagem, leads, atribuições, consultas e vendas. Ao entrar
        novamente neste aparelho, o CRM restabelece os avisos automaticamente. Use “Desativar” para
        desligá-los neste aparelho.
      </p>
      {temporaryOptOut.has(userId) && (
        <p role="status">
          Não foi possível salvar sua preferência de notificações. Ela será respeitada enquanto esta
          página estiver aberta. Ao recarregar ou reabrir o CRM, confira essa configuração
          novamente.
        </p>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
