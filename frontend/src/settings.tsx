import { useId, useState, type ReactNode } from 'react';
import {
  ChevronDown,
  Eye,
  KeyRound,
  Link2,
  LogOut,
  ShieldCheck,
  Smartphone,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { Snapshot } from './api';
import { CentralStatusPanel } from './central';
import { ConversationPortfolioSharing, PasswordChange, Team } from './operations';
import { DevicePanel } from './pwa';

function SettingsSection({
  title,
  description,
  icon: Icon,
  expanded,
  onToggle,
  children,
}: {
  title: string;
  description: string;
  icon: LucideIcon;
  expanded: boolean;
  onToggle: () => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="settings-section" data-expanded={expanded}>
      <h2 className="settings-section-heading">
        <button
          type="button"
          className="settings-section-toggle"
          id={`${id}-toggle`}
          aria-label={title}
          aria-describedby={`${id}-description`}
          aria-expanded={expanded}
          aria-controls={`${id}-content`}
          onClick={onToggle}
        >
          <span className="settings-section-icon" aria-hidden="true">
            <Icon size={21} />
          </span>
          <span className="settings-section-copy">
            <span className="settings-section-title">{title}</span>
            <span className="settings-section-description" id={`${id}-description`}>
              {description}
            </span>
          </span>
          <ChevronDown className="settings-section-chevron" size={19} aria-hidden="true" />
        </button>
      </h2>
      <div
        className="settings-section-body"
        id={`${id}-content`}
        role="region"
        aria-labelledby={`${id}-toggle`}
        hidden={!expanded}
      >
        {children}
      </div>
    </section>
  );
}

export function SettingsPage({
  data,
  connected,
  onChanged,
  onLogout,
  onPasswordChanged,
}: {
  data: Snapshot;
  connected: boolean;
  onChanged: () => Promise<void>;
  onLogout: () => void;
  onPasswordChanged: () => void;
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const isManager = data.user.role === 'manager';
  const account = (
    <section className="panel account-panel">
      <div className="panel-heading">
        <h2>Minha conta</h2>
        <ShieldCheck size={21} />
      </div>
      <div className="profile-card">
        <h2>{data.user.name}</h2>
        <p>Login: {data.user.email}</p>
        <span className="stage-pill">{isManager ? 'Gestão' : 'Atendimento'}</span>
        <button className="button outline" onClick={onLogout}>
          <LogOut size={16} /> Sair e acessar outro perfil
        </button>
      </div>
    </section>
  );
  const device = (
    <section className="panel device-panel">
      <div className="panel-heading">
        <h2>Este aparelho</h2>
        <Smartphone size={22} />
      </div>
      <div className="modal-body">
        <DevicePanel userId={data.user.id} />
      </div>
    </section>
  );
  const password = <PasswordChange onDone={onPasswordChanged} />;

  if (!isManager)
    return (
      <div className="settings-extension settings-page">
        {account}
        {password}
        {device}
      </div>
    );

  const disclosure = (key: string) => ({
    expanded: !!expanded[key],
    onToggle: () => setExpanded((current) => ({ ...current, [key]: !current[key] })),
  });

  return (
    <div className="manager-settings">
      <div className="settings-intro">
        <p>Gerencie sua equipe e personalize o CRM. Abra a seção que deseja consultar.</p>
        <button
          className="button outline compact"
          type="button"
          disabled={!Object.values(expanded).some(Boolean)}
          onClick={() => setExpanded({})}
        >
          Recolher tudo
        </button>
      </div>
      <div className="settings-group" role="group" aria-labelledby="settings-team-title">
        <h2 className="settings-group-title" id="settings-team-title">
          Equipe e atendimento
        </h2>
        <SettingsSection
          title="Equipe e acessos"
          description="Cadastre consultores, gerencie acessos e redefina senhas."
          icon={Users}
          {...disclosure('team')}
        >
          <Team data={data} connected={connected} onChanged={onChanged} />
        </SettingsSection>
        <SettingsSection
          title="Compartilhar carteira de conversas"
          description="Escolha quem pode revisar e assumir conversas de outro consultor."
          icon={Eye}
          {...disclosure('portfolio')}
        >
          <ConversationPortfolioSharing data={data} connected={connected} />
        </SettingsSection>
      </div>
      <div className="settings-group" role="group" aria-labelledby="settings-account-title">
        <h2 className="settings-group-title" id="settings-account-title">
          Conta e aparelho
        </h2>
        <SettingsSection
          title="Minha conta"
          description="Consulte seu perfil ou entre com outra conta."
          icon={ShieldCheck}
          {...disclosure('account')}
        >
          {account}
        </SettingsSection>
        <SettingsSection
          title="Alterar minha senha"
          description="Atualize a senha usada para acessar o CRM."
          icon={KeyRound}
          {...disclosure('password')}
        >
          {password}
        </SettingsSection>
        <SettingsSection
          title="Este aparelho"
          description="Instale o aplicativo e configure notificações e sons."
          icon={Smartphone}
          {...disclosure('device')}
        >
          {device}
        </SettingsSection>
      </div>
      <div className="settings-group" role="group" aria-labelledby="settings-channels-title">
        <h2 className="settings-group-title" id="settings-channels-title">
          Canais de atendimento
        </h2>
        <SettingsSection
          title="Conexões dos canais"
          description="Consulte o recebimento de mensagens do Instagram, Messenger e WhatsApp."
          icon={Link2}
          {...disclosure('channels')}
        >
          <div className="settings-channels">
            <CentralStatusPanel />
          </div>
        </SettingsSection>
      </div>
    </div>
  );
}
