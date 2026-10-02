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
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event as InstallEvent;
  window.dispatchEvent(new Event('artisti-install'));
});
window.addEventListener('appinstalled', () => {
  installPrompt = null;
  window.dispatchEvent(new Event('artisti-install'));
});
export function registerDeviceWorker() {
  if (!('serviceWorker' in navigator) || !window.isSecureContext) return Promise.resolve(undefined);
  return (worker ??= navigator.serviceWorker
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
    .catch(() => undefined));
}
const installed = () =>
  matchMedia('(display-mode: standalone)').matches ||
  (navigator as Navigator & { standalone?: boolean }).standalone === true;
const ios = () =>
  /iPad|iPhone|iPod/.test(navigator.userAgent) ||
  (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
export async function disconnectPush(localOnly = false) {
  if (!('serviceWorker' in navigator)) return;
  const registration = await navigator.serviceWorker.getRegistration('/');
  const subscription = await registration?.pushManager?.getSubscription();
  if (subscription) {
    if (!localOnly)
      await api('/push/subscriptions', {
        method: 'DELETE',
        body: JSON.stringify({ endpoint: subscription.endpoint }),
      });
    await subscription.unsubscribe();
  }
}
const subscriptionKey = (subscription: PushSubscription) =>
  subscription.options.applicationServerKey
    ? btoa(String.fromCharCode(...new Uint8Array(subscription.options.applicationServerKey)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '')
    : '';
async function bindExisting(publicKey: string | null) {
  if (!publicKey || !('Notification' in window) || Notification.permission !== 'granted')
    return false;
  const registration = await registerDeviceWorker();
  const subscription = await registration?.pushManager?.getSubscription();
  if (!subscription || subscriptionKey(subscription) !== publicKey) return false;
  await api('/push/subscriptions', { method: 'POST', body: JSON.stringify(subscription.toJSON()) });
  return true;
}
export function PushBinding({ userId }: { userId: string }) {
  useEffect(() => {
    const seen = new Set<string>();
    const unlock = () => {
      if (soundEnabled(userId)) void prepareNotificationSound();
    };
    const receive = (event: MessageEvent) => {
      const value = event.data;
      if (
        value?.type !== 'artisti-push' ||
        value.userId !== userId ||
        typeof value.tag !== 'string' ||
        document.hidden ||
        seen.has(value.tag)
      )
        return;
      seen.add(value.tag);
      if (seen.size > 200) seen.delete(seen.values().next().value!);
      if (soundEnabled(userId)) playNotificationSound();
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
    void api<{ enabled: boolean; publicKey: string | null }>('/push/config')
      .then((value) => {
        if (!disposed && value.enabled) return bindExisting(value.publicKey);
      })
      .catch(() => {
        /* The device panel exposes a retry; never block the workspace. */
      });
    return () => {
      disposed = true;
    };
  }, [userId]);
  return null;
}
export function DevicePanel({ userId }: { userId: string }) {
  const [config, setConfig] = useState<{ enabled: boolean; publicKey: string | null }>();
  const [isInstalled, setInstalled] = useState(installed);
  const [canInstall, setCanInstall] = useState(!!installPrompt);
  const [subscribed, setSubscribed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
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
    void (async () => {
      try {
        const value = await api<{ enabled: boolean; publicKey: string | null }>('/push/config');
        if (disposed) return;
        setConfig(value);
        const bound = value.enabled && (await bindExisting(value.publicKey));
        if (!disposed) setSubscribed(bound);
      } catch {
        if (!disposed)
          setError(
            'Não foi possível consultar as notificações. Feche e reabra esta área para tentar novamente.',
          );
      }
    })();
    return () => {
      disposed = true;
      window.removeEventListener('artisti-install', change);
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
      const registration = await registerDeviceWorker();
      if (!registration?.active)
        throw new Error(
          'A instalação ainda está sendo preparada. Tente novamente em alguns segundos.',
        );
      const bytes = Uint8Array.from(
        atob(config.publicKey.replace(/-/g, '+').replace(/_/g, '/')),
        (char) => char.charCodeAt(0),
      );
      let subscription = await registration.pushManager.getSubscription();
      if (
        subscription &&
        subscription.options.applicationServerKey &&
        btoa(String.fromCharCode(...new Uint8Array(subscription.options.applicationServerKey)))
          .replace(/\+/g, '-')
          .replace(/\//g, '_')
          .replace(/=+$/, '') !== config.publicKey
      ) {
        await subscription.unsubscribe();
        subscription = null;
      }
      subscription ??= await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      });
      await api('/push/subscriptions', {
        method: 'POST',
        body: JSON.stringify(subscription.toJSON()),
      });
      setSubscribed(true);
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
        await disconnectPush();
        setSubscribed(false);
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
      ) : !config ? (
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
        Os avisos incluem cada nova mensagem, leads, atribuições, consultas e vendas. Sair da conta
        desativa os avisos deste aparelho.
      </p>
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      {notice && <p role="status">{notice}</p>}
    </div>
  );
}
