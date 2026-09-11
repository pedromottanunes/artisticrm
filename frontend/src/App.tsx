import { useState, useEffect, useCallback, useRef, type FormEvent } from 'react';
import {
  LayoutDashboard,
  Users,
  GitBranch,
  CalendarDays,
  Shuffle,
  ChartNoAxesCombined,
  Settings,
  Search,
  Plus,
  ArrowRight,
  ArrowUpRight,
  Bell,
  LogOut,
  Menu,
  ChevronRight,
  Clock3,
  Inbox,
  MessageCircle,
  ShieldCheck,
  Link2,
  WifiOff,
  SlidersHorizontal,
  FileCheck2,
  Info,
  X,
  Smartphone,
  LockKeyhole,
} from 'lucide-react';
import { api, ApiError, stages, type Snapshot, type Lead, type Detail } from './api';
import { CentralStatusPanel } from './central';
import {
  Avatar,
  Badge,
  Source,
  Empty,
  Modal,
  Countdown,
  TextLink,
  IconButton,
  dateLabel,
} from './components';
import { LeadForm, LeadDetail, QueueSettings } from './forms';
import { Team, PasswordChange } from './operations';

type Page =
  | 'overview'
  | 'leads'
  | 'pipeline'
  | 'agenda'
  | 'distribution'
  | 'meta'
  | 'google'
  | 'contracts'
  | 'settings'
  | 'mine'
  | 'pool';
const navItems: { id: Page; label: string; icon: typeof Users; group: string }[] = [
  { id: 'overview', label: 'Visão geral', icon: LayoutDashboard, group: 'workspace' },
  { id: 'leads', label: 'Leads', icon: Users, group: 'workspace' },
  { id: 'pipeline', label: 'Funil de vendas', icon: GitBranch, group: 'workspace' },
  { id: 'agenda', label: 'Agenda', icon: CalendarDays, group: 'workspace' },
  { id: 'distribution', label: 'Distribuição', icon: Shuffle, group: 'workspace' },
  { id: 'meta', label: 'Meta Ads', icon: ChartNoAxesCombined, group: 'growth' },
  { id: 'google', label: 'Google Ads', icon: Search, group: 'growth' },
  { id: 'contracts', label: 'Contratos', icon: FileCheck2, group: 'growth' },
  { id: 'settings', label: 'Configurações', icon: Settings, group: 'system' },
];
const salesNav = [
  { id: 'mine' as Page, label: 'Meus leads', icon: Users },
  { id: 'pool' as Page, label: 'Bolsão', icon: Inbox },
  { id: 'agenda' as Page, label: 'Agenda', icon: CalendarDays },
  { id: 'settings' as Page, label: 'Meu perfil', icon: Settings },
];

export function App() {
  const [data, setData] = useState<Snapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [connected, setConnected] = useState(true);
  const [page, setPage] = useState<Page>('overview');
  const [search, setSearch] = useState('');
  const [source, setSource] = useState('Todas as origens');
  const [mobileMenu, setMobileMenu] = useState(false);
  const [notice, setNotice] = useState('');
  const [newLead, setNewLead] = useState(false);
  const [detail, setDetail] = useState<Detail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [notifications, setNotifications] = useState(false);
  const [whatsappUrl, setWhatsappUrl] = useState('');
  const [busyId, setBusyId] = useState('');
  const [now, setNow] = useState(Date.now());
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const generation = useRef(0);
  const requestSeq = useRef(0);
  const appliedSeq = useRef(0);
  const claims = useRef(new Map<string, { key: string; version: number; mode: string }>());
  const detailSeq = useRef(0);
  const refresh = useCallback(async () => {
    const epoch = generation.current;
    const sequence = ++requestSeq.current;
    try {
      const snapshot = await api<Snapshot>('/workspace');
      if (epoch !== generation.current || sequence < appliedSeq.current) return;
      appliedSeq.current = sequence;
      setData(snapshot);
      setConnected(true);
      setLastUpdated(new Date());
      setNow(new Date(snapshot.server_time).getTime());
    } catch (error) {
      if (epoch !== generation.current || sequence < appliedSeq.current) return;
      if (error instanceof ApiError && error.status === 401) {
        generation.current++;
        detailSeq.current++;
        setData(null);
        setDetail(null);
        setWhatsappUrl('');
        setNewLead(false);
        setNotifications(false);
        setLoading(false);
      } else setConnected(false);
    } finally {
      if (epoch === generation.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    if (!detail || !data || data.user.role === 'manager') return;
    const current = data.opportunities.find((l) => l.id === detail.id);
    if (
      !current ||
      current.owner_id !== detail.owner_id ||
      current.reserved_to !== detail.reserved_to
    ) {
      detailSeq.current++;
      setDetail(null);
      setWhatsappUrl('');
    }
  }, [data, detail]);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  useEffect(() => {
    if (!data) return;
    const interval = setInterval(() => void refresh(), 5000);
    const focus = () => void refresh();
    window.addEventListener('focus', focus);
    window.addEventListener('online', focus);
    return () => {
      clearInterval(interval);
      window.removeEventListener('focus', focus);
      window.removeEventListener('online', focus);
    };
  }, [data?.user.id, refresh]);
  useEffect(() => {
    const id = setInterval(() => setNow((n) => n + 1000), 1000);
    return () => clearInterval(id);
  }, []);
  useEffect(() => {
    if (!notice) return;
    const id = setTimeout(() => setNotice(''), 8000);
    return () => clearTimeout(id);
  }, [notice]);
  const navigate = (next: Page) => {
    setPage(next);
    setMobileMenu(false);
    setSearch('');
  };
  const openDetail = async (id: string) => {
    const sequence = ++detailSeq.current;
    const epoch = generation.current;
    setDetailLoading(true);
    try {
      const result = await api<Detail>(`/opportunities/${id}`);
      if (sequence === detailSeq.current && epoch === generation.current) setDetail(result);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      if (sequence === detailSeq.current) setDetailLoading(false);
    }
  };
  const openWhatsApp = async (lead: Lead) => {
    if (lead.is_demo) {
      setNotice('Contato fictício: nenhum WhatsApp será aberto. O aceite está salvo no CRM.');
      return;
    }
    try {
      const result = await api<{ url: string }>(`/opportunities/${lead.id}/whatsapp-link`, {
        method: 'POST',
        body: '{}',
      });
      setWhatsappUrl(result.url);
    } catch (error) {
      setNotice((error as Error).message);
    }
  };
  const claim = async (lead: Lead) => {
    if (busyId || !connected) return;
    setBusyId(lead.id);
    const command = claims.current.get(lead.id) ?? {
      key: crypto.randomUUID(),
      version: lead.version,
      mode: lead.state === 'POOL' ? 'pool' : 'reservation',
    };
    claims.current.set(lead.id, command);
    try {
      await api(`/opportunities/${lead.id}/claim`, {
        method: 'POST',
        headers: { 'Idempotency-Key': command.key },
        body: JSON.stringify({ mode: command.mode, expected_version: command.version }),
      });
      claims.current.delete(lead.id);
      setNotice('Lead assumido. A conversa acontece no seu WhatsApp.');
      setDetail(null);
      await refresh();
      await openWhatsApp(lead);
    } catch (error) {
      if (error instanceof ApiError && error.status < 500) claims.current.delete(lead.id);
      setNotice((error as Error).message);
      await refresh();
    } finally {
      setBusyId('');
    }
  };
  const logout = async () => {
    try {
      await api('/auth/logout', { method: 'POST', body: '{}' });
      generation.current++;
      detailSeq.current++;
      setData(null);
      setDetail(null);
      setSearch('');
      setWhatsappUrl('');
      claims.current.clear();
      setNotifications(false);
      setNewLead(false);
      setNotice('');
      setPage('overview');
    } catch (error) {
      setNotice((error as Error).message);
    }
  };
  const passwordDone = () => {
    generation.current++;
    detailSeq.current++;
    setData(null);
    setDetail(null);
    setWhatsappUrl('');
    setNewLead(false);
    setNotifications(false);
    setNotice('');
    setPage('overview');
  };
  if (loading)
    return (
      <div className="boot">
        <img src="/artisti-logo.webp" alt="Artisti Transplante Capilar" />
        <span className="loader" />
        <p>Preparando seu espaço de trabalho</p>
      </div>
    );
  if (!data)
    return (
      <Login
        connected={connected}
        onLogin={async () => {
          generation.current++;
          await refresh();
          setPage('overview');
        }}
      />
    );
  if (data.user.must_change_password)
    return (
      <div className="password-gate">
        <PasswordChange required onDone={passwordDone} />
        <button className="button outline" onClick={() => void logout()}>
          Sair
        </button>
      </div>
    );
  const isManager = data.user.role === 'manager';
  const activePage =
    !isManager && !['mine', 'pool', 'agenda', 'settings'].includes(page) ? 'mine' : page;
  const leads = data.opportunities;
  const pool = leads.filter((l) => l.state === 'POOL');
  const reserved = leads.filter((l) => l.state === 'RESERVED');
  const owned = leads.filter(
    (l) =>
      l.owner_id === data.user.id || (l.state === 'RESERVED' && l.reserved_to === data.user.id),
  );
  const attendants = data.users.filter((u) => u.role === 'attendant');
  const filtered = leads.filter(
    (l) =>
      `${l.name} ${l.phone ?? ''}`.toLowerCase().includes(search.toLowerCase()) &&
      (source === 'Todas as origens' || source === l.source),
  );
  const title = isManager
    ? navItems.find((n) => n.id === activePage)?.label
    : salesNav.find((n) => n.id === activePage)?.label;
  const nextAttendant = attendants
    .filter((u) => u.active && u.queue_enabled)
    .sort(
      (a, b) =>
        (a.queue_position! > data.settings.last_position ? 0 : 1) -
          (b.queue_position! > data.settings.last_position ? 0 : 1) ||
        a.queue_position! - b.queue_position!,
    )[0];
  const actionButton = (lead: Lead) => {
    if (!isManager && ['RESERVED', 'POOL'].includes(lead.state))
      return (
        <button
          className="button gold compact"
          disabled={
            !connected ||
            !!busyId ||
            (lead.state === 'RESERVED' && new Date(lead.expires_at!).getTime() <= now)
          }
          onClick={() => void claim(lead)}
        >
          {busyId === lead.id ? 'Confirmando…' : 'Assumir lead'}
          <ArrowUpRight size={14} />
        </button>
      );
    if (!isManager && lead.owner_id === data.user.id)
      return (
        <button
          className="button outline compact"
          disabled={!connected}
          onClick={() => void openWhatsApp(lead)}
        >
          <MessageCircle size={14} />
          WhatsApp
        </button>
      );
    return (
      <IconButton label={`Abrir ficha de ${lead.name}`} onClick={() => void openDetail(lead.id)}>
        <ArrowUpRight size={17} />
      </IconButton>
    );
  };
  const leadTable = (rows: Lead[], compact = false) => (
    <div className="table-scroll">
      <table className="leads-table">
        <thead>
          <tr>
            <th>Contato</th>
            <th>Origem</th>
            {!compact && <th>Etapa</th>}
            <th>Atendente</th>
            <th>Situação</th>
            <th>
              <span className="sr-only">Ações</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((lead) => (
            <tr key={lead.id}>
              <td>
                <button className="contact-cell" onClick={() => void openDetail(lead.id)}>
                  <Avatar name={lead.name} />
                  <span>
                    <strong>{lead.name}</strong>
                    <small>{lead.interest || 'Interesse a identificar'}</small>
                  </span>
                </button>
              </td>
              <td>
                <Source value={lead.source} />
              </td>
              {!compact && (
                <td>
                  <span className="stage-pill">{stages[lead.stage]}</span>
                </td>
              )}
              <td>
                {lead.owner_id || lead.state === 'RESERVED' ? (
                  <span className="owner-cell">
                    <Avatar
                      user={data.users.find((u) => u.id === (lead.owner_id ?? lead.reserved_to))}
                      small
                    />
                    {data.users.find((u) => u.id === (lead.owner_id ?? lead.reserved_to))?.name}
                  </span>
                ) : (
                  <span className="muted">—</span>
                )}
              </td>
              <td>
                <Badge state={lead.state} />
                {lead.state === 'RESERVED' && <Countdown lead={lead} now={now} />}
              </td>
              <td>{actionButton(lead)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && (
        <Empty
          title="Nenhum lead por aqui"
          description="Novos contatos aparecerão aqui após o cadastro e a distribuição."
        />
      )}
    </div>
  );
  return (
    <div className="app-shell">
      {mobileMenu && (
        <button
          className="sidebar-scrim"
          aria-label="Fechar menu"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className={`sidebar ${mobileMenu ? 'is-open' : ''}`}>
        <div className="brand">
          <img src="/artisti-logo.webp" alt="Artisti Transplante Capilar" />
        </div>
        <div className="workspace-label">
          <span className="workspace-icon">
            <GitBranch size={17} />
          </span>
          <div>
            <strong>Artisti CRM</strong>
          </div>
          <ChevronRight size={15} />
        </div>
        <nav aria-label="Menu principal">
          {isManager ? (
            <>
              {['workspace', 'growth', 'system'].map((group) => (
                <div className="nav-group" key={group}>
                  <p>
                    {group === 'workspace'
                      ? 'RELACIONAMENTO'
                      : group === 'growth'
                        ? 'CRESCIMENTO'
                        : 'PREFERÊNCIAS'}
                  </p>
                  {navItems
                    .filter((item) => item.group === group)
                    .map(({ id, label, icon: Icon }) => (
                      <button
                        key={id}
                        className={`nav-item ${activePage === id ? 'active' : ''}`}
                        onClick={() => navigate(id)}
                      >
                        <Icon size={18} />
                        <span>{label}</span>
                        {id === 'leads' && <b>{leads.length}</b>}
                        {id === 'distribution' && pool.length > 0 && <i className="nav-dot" />}
                      </button>
                    ))}
                </div>
              ))}
            </>
          ) : (
            <div className="nav-group">
              <p>SEU ATENDIMENTO</p>
              {salesNav.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={`nav-item ${activePage === id ? 'active' : ''}`}
                  onClick={() => navigate(id)}
                >
                  <Icon size={18} />
                  <span>{label}</span>
                  {id === 'pool' && <b>{pool.length}</b>}
                </button>
              ))}
            </div>
          )}
        </nav>
        <div className="sidebar-bottom">
          <div className="local-label">
            <span className="status-dot" />
            {data.demo ? 'Ambiente de demonstração' : 'Ambiente de homologação'}
            <small>Versão de homologação</small>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="icon-button mobile-toggle"
              aria-label="Abrir menu"
              onClick={() => setMobileMenu(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <ChevronRight size={13} />
            <strong>{title}</strong>
          </div>
          <div className="topbar-right">
            <span className={`sync-status ${connected ? '' : 'offline'}`}>
              <i />
              {connected ? 'Sincronizado' : 'Sem conexão'}
            </span>
            <span className="topbar-divider" />
            <IconButton label="Central de avisos" onClick={() => setNotifications(true)}>
              <Bell size={19} />
            </IconButton>
            <Avatar user={data.user} small />
            <IconButton label="Sair da conta" onClick={() => void logout()}>
              <LogOut size={18} />
            </IconButton>
          </div>
        </header>
        <main>
          {!connected && (
            <div className="connection-banner" role="alert">
              <WifiOff size={17} />
              Conexão interrompida. Os dados podem estar desatualizados; ações críticas estão
              suspensas.<button onClick={() => void refresh()}>Tentar novamente</button>
            </div>
          )}
          <div className="demo-strip">
            <span>
              <Info size={13} />
              {data.demo
                ? 'Demonstração local com contatos fictícios.'
                : 'Homologação: utilize apenas dados de teste.'}{' '}
              Nenhuma mensagem ou campanha conectada.
            </span>
            <span>VERSÃO 0.1</span>
          </div>
          <section className="page-heading">
            <div>
              <h1>
                {activePage === 'overview'
                  ? 'Visão geral'
                  : activePage === 'mine'
                    ? 'Meus atendimentos'
                    : title}
              </h1>
              <p>
                {activePage === 'overview'
                  ? 'Acompanhe os leads, atendimentos, avaliações e o rodízio da equipe.'
                  : activePage === 'mine'
                    ? 'Consulte suas reservas e os leads sob sua responsabilidade.'
                    : activePage === 'pool'
                      ? 'Oportunidades disponíveis. O primeiro aceite confirmado assume.'
                      : ''}
              </p>
            </div>
            <div className="heading-actions">
              {isManager && !['meta', 'google', 'settings'].includes(activePage) && (
                <button
                  className="button gold"
                  onClick={() => setNewLead(true)}
                  disabled={!connected}
                >
                  <Plus size={17} />
                  Novo lead
                </button>
              )}
              <span className="today-label">
                {new Intl.DateTimeFormat('pt-BR', {
                  day: 'numeric',
                  month: 'long',
                  year: 'numeric',
                }).format(new Date())}
              </span>
            </div>
          </section>

          {activePage === 'overview' && (
            <>
              <div className="stats-grid">
                {[
                  {
                    label: 'Oportunidades na base',
                    value: leads.length,
                    icon: Users,
                    note: 'Registros nesta visualização',
                    accent: 'gold',
                  },
                  {
                    label: 'Em atendimento',
                    value: leads.filter((l) => l.state === 'CLAIMED').length,
                    icon: MessageCircle,
                    note: 'Aceite confirmado no CRM',
                    accent: 'mint',
                  },
                  {
                    label: 'Avaliações agendadas',
                    value: data.appointments.filter((a) => a.status === 'scheduled').length,
                    icon: CalendarDays,
                    note: 'Compromissos registrados',
                    accent: 'blue',
                  },
                  {
                    label: 'Disponíveis no bolsão',
                    value: pool.length,
                    icon: Inbox,
                    note: pool.length ? 'Aguardando aceite' : 'Todos os contatos encaminhados',
                    accent: 'amber',
                  },
                ].map(({ label, value, icon: Icon, note, accent }) => (
                  <article className={`stat-card ${accent}`} key={label}>
                    <div>
                      <span>{label}</span>
                      <Icon size={18} />
                    </div>
                    <strong>{String(value).padStart(2, '0')}</strong>
                    <small>
                      {accent === 'amber' ? <Clock3 size={13} /> : <span className="mini-line" />}
                      {note}
                    </small>
                  </article>
                ))}
              </div>
              <div className="overview-grid">
                <section className="panel funnel-panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Funil de vendas</h2>
                    </div>
                    <TextLink onClick={() => navigate('pipeline')}>Ver funil</TextLink>
                  </div>
                  <div className="funnel-chart">
                    {Object.entries(stages)
                      .filter(([key]) => key !== 'LOST')
                      .map(([key, label], index) => {
                        const count = leads.filter((l) => l.stage === key).length;
                        return (
                          <button
                            key={key}
                            className="funnel-step"
                            onClick={() => navigate('pipeline')}
                          >
                            <div className="funnel-value">
                              <strong>{String(count).padStart(2, '0')}</strong>
                              <span>
                                {leads.length ? Math.round((count / leads.length) * 100) : 0}% da
                                base
                              </span>
                            </div>
                            <div
                              className={`funnel-bar step-${index}`}
                              style={{
                                height: `${Math.max(16, (count / Math.max(1, leads.length)) * 200)}px`,
                              }}
                            />
                            <div className="funnel-label">
                              <i />
                              {label}
                            </div>
                            <small>0{index + 1}</small>
                          </button>
                        );
                      })}
                  </div>
                  <div className="panel-footnote">
                    <Info size={12} />
                    Distribuição atual por etapa, não taxa de conversão entre etapas.
                  </div>
                </section>
                <section className="panel queue-preview">
                  <div className="panel-heading">
                    <div>
                      <h2>Rodízio da equipe</h2>
                    </div>
                    <Shuffle size={19} />
                  </div>
                  <div className="queue-users">
                    {attendants.map((user) => (
                      <div
                        className={`queue-person ${nextAttendant?.id === user.id ? 'next' : ''}`}
                        key={user.id}
                      >
                        <span className="queue-number">0{user.queue_position}</span>
                        <Avatar user={user} />
                        <div>
                          <strong>{user.name}</strong>
                          <small>
                            {user.queue_enabled
                              ? `${leads.filter((l) => l.owner_id === user.id).length} em atendimento`
                              : 'Fora do rodízio'}
                          </small>
                        </div>
                        {nextAttendant?.id === user.id ? (
                          <span className="next-tag">PRÓXIMA</span>
                        ) : (
                          <span className={`status-dot ${user.queue_enabled ? '' : 'paused'}`} />
                        )}
                      </div>
                    ))}
                  </div>
                  <div className="queue-bottom">
                    <Clock3 size={15} />
                    <span>
                      Reserva de <strong>{data.settings.timeout_minutes} minutos</strong>
                    </span>
                    <TextLink onClick={() => navigate('distribution')}>Gerenciar</TextLink>
                  </div>
                </section>
              </div>
              <section className="panel">
                <div className="panel-heading">
                  <div>
                    <h2>Leads mais recentes</h2>
                  </div>
                  <TextLink onClick={() => navigate('leads')}>Todos os leads</TextLink>
                </div>
                {leadTable(leads.slice(0, 5), true)}
              </section>
            </>
          )}

          {activePage === 'leads' && (
            <section className="panel">
              <div className="list-toolbar">
                <div className="tab-label">
                  Todos os leads <span>{leads.length}</span>
                </div>
                <div className="table-filters">
                  <label className="search-field">
                    <Search size={17} />
                    <input
                      placeholder="Buscar nome ou telefone"
                      aria-label="Buscar nome ou telefone"
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                    />
                  </label>
                  <label className="select-filter">
                    <SlidersHorizontal size={15} />
                    <select
                      aria-label="Filtrar origem"
                      value={source}
                      onChange={(e) => setSource(e.target.value)}
                    >
                      {[
                        'Todas as origens',
                        'Google Ads',
                        'Meta Ads',
                        'Não identificada',
                        'Cadastro manual',
                        'Indicação',
                      ].map((s) => (
                        <option key={s}>{s}</option>
                      ))}
                    </select>
                  </label>
                </div>
              </div>
              {leadTable(filtered)}
              <div className="panel-footnote">
                {filtered.length} de {leads.length} oportunidades • Origem manual não equivale a
                atribuição de anúncio verificada.
              </div>
            </section>
          )}

          {activePage === 'pipeline' && (
            <div className="kanban">
              {Object.entries(stages).map(([key, label]) => (
                <section className="kanban-column" key={key}>
                  <header>
                    <i className={`stage-dot ${key}`} />
                    <h2>{label}</h2>
                    <span>{leads.filter((l) => l.stage === key).length}</span>
                  </header>
                  <div className="kanban-cards">
                    {leads
                      .filter((l) => l.stage === key)
                      .map((lead) => (
                        <button
                          className="kanban-card"
                          onClick={() => void openDetail(lead.id)}
                          key={lead.id}
                        >
                          <Source value={lead.source} />
                          <h3>{lead.name}</h3>
                          <p>{lead.interest || 'Interesse a definir'}</p>
                          <span className="kanban-action">
                            <Clock3 size={13} />
                            {lead.next_action || 'Definir próximo passo'}
                          </span>
                          <footer>
                            <Avatar
                              user={data.users.find(
                                (u) => u.id === (lead.owner_id ?? lead.reserved_to),
                              )}
                              small
                            />
                            <span>{dateLabel(lead.created_at)}</span>
                            <ArrowUpRight size={14} />
                          </footer>
                        </button>
                      ))}
                    {!leads.some((l) => l.stage === key) && (
                      <p className="column-empty">
                        {key === 'WON'
                          ? 'A validação de contratos estará disponível na próxima etapa.'
                          : 'Nenhuma oportunidade nesta etapa.'}
                      </p>
                    )}
                  </div>
                </section>
              ))}
            </div>
          )}

          {activePage === 'agenda' && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Próximas avaliações</h2>
                  <p>
                    Horários no fuso deste dispositivo:{' '}
                    {Intl.DateTimeFormat().resolvedOptions().timeZone}.
                  </p>
                </div>
                <CalendarDays size={22} />
              </div>
              {!data.appointments.length ? (
                <Empty
                  title="Nenhuma avaliação agendada"
                  description="Abra a ficha de um lead para agendar uma avaliação."
                />
              ) : (
                <div className="appointment-list">
                  {data.appointments.map((a) => (
                    <button
                      className="appointment-card"
                      key={a.id}
                      onClick={() => void openDetail(a.opportunity_id)}
                    >
                      <span className="calendar-date">
                        <strong>{new Date(a.starts_at).getDate()}</strong>
                        {new Intl.DateTimeFormat('pt-BR', { month: 'short' }).format(
                          new Date(a.starts_at),
                        )}
                      </span>
                      <div>
                        <strong>{a.name}</strong>
                        <span>{a.unit}</span>
                      </div>
                      <span className="appointment-time">
                        <Clock3 size={15} />
                        {new Intl.DateTimeFormat('pt-BR', {
                          hour: '2-digit',
                          minute: '2-digit',
                        }).format(new Date(a.starts_at))}
                      </span>
                      <span className="stage-pill">
                        {{ scheduled: 'Agendada', completed: 'Concluída', cancelled: 'Cancelada' }[
                          a.status
                        ] ?? a.status}
                      </span>
                      <ArrowUpRight size={18} />
                    </button>
                  ))}
                </div>
              )}
            </section>
          )}

          {activePage === 'distribution' && (
            <>
              <div className="distribution-hero">
                <div className="round-robin-icon">
                  <Shuffle size={28} />
                </div>
                <div>
                  <h2>Configuração do rodízio</h2>
                  <p>
                    Rodízio sequencial. Após {data.settings.timeout_minutes} minutos sem aceite, a
                    reserva vai para o bolsão, disponível para todas as atendentes com acesso ativo.
                    A primeira que assumir fica responsável. O aceite não confirma envio no
                    WhatsApp.
                  </p>
                </div>
                <div className="distribution-numbers">
                  <strong>
                    {reserved.length}
                    <small>reservas</small>
                  </strong>
                  <strong>
                    {pool.length}
                    <small>no bolsão</small>
                  </strong>
                </div>
              </div>
              <div className="two-columns">
                <QueueSettings
                  data={data}
                  connected={connected}
                  onSaved={refresh}
                  onNotice={setNotice}
                />
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>Bolsão compartilhado</h2>
                      <p>O aceite acontece no perfil da atendente.</p>
                    </div>
                    <Inbox size={21} />
                  </div>
                  {pool.length ? (
                    <div className="pool-summary">
                      {pool.map((lead) => (
                        <button key={lead.id} onClick={() => void openDetail(lead.id)}>
                          <Avatar name={lead.name} />
                          <span>
                            <strong>{lead.name}</strong>
                            <small>{lead.source}</small>
                          </span>
                          <Badge state="POOL" />
                          <ArrowUpRight size={16} />
                        </button>
                      ))}
                    </div>
                  ) : (
                    <Empty
                      title="Bolsão em dia"
                      description="As reservas vencidas aparecem aqui automaticamente."
                    />
                  )}
                </section>
              </div>
              {leads.some((l) => l.state === 'PENDING' && !l.needs_review) && (
                <div className="connection-banner">
                  <Info size={18} />
                  Há leads sem atendente. Habilite a equipe e salve a configuração para
                  distribuí-los.
                </div>
              )}
              {leads.some((l) => l.needs_review) && (
                <section className="panel settings-extension-block">
                  <div className="panel-heading">
                    <div>
                      <h2>Retornos aguardando revisão</h2>
                      <p>
                        Confira o histórico do contato e atribua a nova oportunidade pela ficha.
                      </p>
                    </div>
                    <ShieldCheck size={20} />
                  </div>
                  {leadTable(
                    leads.filter((l) => l.needs_review),
                    true,
                  )}
                </section>
              )}
            </>
          )}

          {(activePage === 'mine' || activePage === 'pool') && (
            <>
              <div className="attendant-summary">
                <div>
                  <span className="status-dot" />
                  <strong>
                    {activePage === 'pool'
                      ? `${pool.length} oportunidades disponíveis`
                      : `${owned.filter((l) => l.state === 'RESERVED').length} novas reservas para você`}
                  </strong>
                </div>
                <p>
                  {activePage === 'pool'
                    ? 'O telefone é liberado somente após o aceite.'
                    : 'Assuma dentro do prazo para manter a oportunidade com você.'}
                </p>
              </div>
              <div className="lead-cards">
                {(activePage === 'pool' ? pool : owned).map((lead) => (
                  <article
                    className={`lead-card ${lead.state === 'RESERVED' ? 'reserved-card' : ''}`}
                    key={lead.id}
                  >
                    <div className="lead-card-top">
                      <Badge state={lead.state} />
                      {lead.state === 'RESERVED' ? (
                        <Countdown lead={lead} now={now} />
                      ) : (
                        <span className="muted">{dateLabel(lead.created_at)}</span>
                      )}
                    </div>
                    <button className="lead-card-identity" onClick={() => void openDetail(lead.id)}>
                      <Avatar name={lead.name} />
                      <span>
                        <h2>{lead.name}</h2>
                        <p>{lead.interest || 'Interesse a identificar'}</p>
                      </span>
                      <ArrowUpRight size={17} />
                    </button>
                    <div className="lead-card-info">
                      <Source value={lead.source} />
                      <span>{lead.unit}</span>
                    </div>
                    {lead.next_action && (
                      <p className="next-action">
                        <Clock3 size={14} />
                        {lead.next_action}
                      </p>
                    )}
                    <footer>
                      <button className="text-link" onClick={() => void openDetail(lead.id)}>
                        Ver ficha
                      </button>
                      {actionButton(lead)}
                    </footer>
                  </article>
                ))}
              </div>
              {!(activePage === 'pool' ? pool : owned).length && (
                <section className="panel">
                  <Empty
                    title={
                      activePage === 'pool'
                        ? 'Tudo encaminhado por aqui'
                        : 'Nenhum atendimento pendente'
                    }
                    description="A tela consulta o servidor a cada 5 segundos enquanto estiver aberta. Notificações push ainda não estão conectadas."
                  />
                </section>
              )}
            </>
          )}

          {(activePage === 'meta' || activePage === 'google') && (
            <IntegrationPage platform={activePage} leads={leads} />
          )}
          {activePage === 'contracts' && (
            <section className="panel">
              <div className="panel-heading">
                <div>
                  <h2>Contratos e comissões</h2>
                  <p>Etapa comercial em preparação.</p>
                </div>
                <LockKeyhole size={23} />
              </div>
              <div className="feature-notice">
                <FileCheck2 size={34} />
                <h2>Funcionalidade ainda não disponível</h2>
                <p>
                  A validação de assinatura e as regras de comissão ainda serão implementadas. Mover
                  um lead para contrato pendente não confirma venda nem libera pagamento.
                </p>
                <span className="badge pending">
                  <i />
                  Não disponível nesta versão
                </span>
              </div>
              {leads.some((l) => l.stage === 'CONTRACT_PENDING') && (
                <>
                  <div className="section-label">OPORTUNIDADES AGUARDANDO CONTRATO</div>
                  {leadTable(
                    leads.filter((l) => l.stage === 'CONTRACT_PENDING'),
                    true,
                  )}
                </>
              )}
            </section>
          )}
          {activePage === 'settings' && (
            <div className="two-columns">
              <section className="panel">
                <div className="panel-heading">
                  <h2>Minha conta</h2>
                  <ShieldCheck size={21} />
                </div>
                <div className="profile-card">
                  <Avatar user={data.user} />
                  <h2>{data.user.name}</h2>
                  <p>{data.user.email}</p>
                  <span className="stage-pill">{isManager ? 'Gestão' : 'Atendimento'}</span>
                  <button className="button outline" onClick={() => void logout()}>
                    <LogOut size={16} />
                    Sair e acessar outro perfil
                  </button>
                </div>
              </section>
              <section className="panel">
                <div className="panel-heading">
                  <h2>Conexões do sistema</h2>
                  <Link2 size={21} />
                </div>
                <div className="integration-list">
                  {['Meta Ads', 'Google Ads', 'Google Tag Manager', 'Notificações push'].map(
                    (name) => (
                      <div key={name}>
                        <span>{name}</span>
                        <span className="badge pending">
                          <i />
                          Não conectado
                        </span>
                      </div>
                    ),
                  )}
                </div>
                <div className="panel-footnote">
                  <Smartphone size={16} />
                  Instalação PWA e push serão validados nos aparelhos reais. Esta versão usa
                  atualização com a página aberta.
                </div>
              </section>
            </div>
          )}
          {activePage === 'settings' && (
            <div className="settings-extension">
              <PasswordChange onDone={passwordDone} />
              {isManager && <Team data={data} connected={connected} onChanged={refresh} />}
              {isManager && <CentralStatusPanel />}
            </div>
          )}
          <footer className="page-footer">
            <span>
              {lastUpdated
                ? `Atualizado às ${lastUpdated.toLocaleTimeString('pt-BR')}`
                : 'Aguardando sincronização'}{' '}
              • Base local
            </span>
          </footer>
        </main>
      </div>
      {!isManager && (
        <nav className="mobile-bottom-nav" aria-label="Atalhos de atendimento">
          {salesNav.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              className={activePage === id ? 'active' : ''}
              onClick={() => navigate(id)}
            >
              <Icon size={20} />
              <span>{label}</span>
            </button>
          ))}
        </nav>
      )}
      {notice && (
        <div className="toast" role="status">
          <Info size={19} />
          <span>{notice}</span>
          <IconButton label="Dispensar aviso" onClick={() => setNotice('')}>
            <X size={16} />
          </IconButton>
        </div>
      )}
      {detailLoading && (
        <div className="toast" role="status">
          <span className="loader" />
          Carregando ficha…
        </div>
      )}
      {newLead && (
        <LeadForm
          onClose={() => setNewLead(false)}
          onCreated={async () => {
            setNewLead(false);
            setNotice('Cadastro recebido. O servidor aplicou a regra de distribuição.');
            await refresh();
          }}
        />
      )}
      {detail && (
        <LeadDetail
          detail={detail}
          users={data.users}
          connected={connected}
          isManager={isManager}
          onClose={() => {
            detailSeq.current++;
            setDetail(null);
          }}
          onSaved={async () => {
            await refresh();
            await openDetail(detail.id);
          }}
          onClaim={() => void claim(detail)}
          onWhatsApp={() => void openWhatsApp(detail)}
          busy={!!busyId}
        />
      )}
      {whatsappUrl && (
        <Modal
          title="Lead assumido"
          description="O CRM abre o contato; a mensagem será enviada por você no WhatsApp."
          onClose={() => setWhatsappUrl('')}
        >
          <div className="modal-body">
            <a
              className="button gold"
              href={whatsappUrl}
              target="_blank"
              rel="noreferrer"
              onClick={() => setWhatsappUrl('')}
            >
              <MessageCircle size={18} />
              Abrir conversa no WhatsApp
              <ArrowUpRight size={17} />
            </a>
            <p className="help-text">
              Se a abertura falhar, o lead continua com você. É possível tentar novamente pela
              ficha.
            </p>
          </div>
        </Modal>
      )}
      {notifications && (
        <Modal
          title="Central de avisos"
          description="Avisos operacionais do CRM."
          onClose={() => setNotifications(false)}
        >
          <div className="modal-body">
            <div className="inline-info">
              <Bell size={20} />
              <span>
                Notificações push ainda não conectadas. Não haverá aviso com o aplicativo fechado
                nesta versão.
              </span>
            </div>
            <div className="notification-line">
              <Inbox size={21} />
              <div>
                <strong>{pool.length} leads no bolsão</strong>
                <p>Disponíveis para aceite pela equipe habilitada.</p>
              </div>
            </div>
            <div className="notification-line">
              <Clock3 size={21} />
              <div>
                <strong>{reserved.length} reservas em andamento</strong>
                <p>Prazo decidido pelo servidor, mesmo se esta tela for fechada.</p>
              </div>
            </div>
          </div>
        </Modal>
      )}
    </div>
  );
}

function Login({ onLogin, connected }: { onLogin: () => Promise<void>; connected: boolean }) {
  const [profile, setProfile] = useState('cadu');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [demoSelected, setDemoSelected] = useState(true);
  const localDemo = import.meta.env.DEV && demoSelected;
  const login = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify(
          localDemo
            ? { email: `${profile}@demo.artisti.local`, password: 'Artisti.demo2026!' }
            : { email, password },
        ),
      });
      await onLogin();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="login-page">
      <div className="login-story">
        <img src="/artisti-logo.webp" alt="Artisti Transplante Capilar" />
        <div className="login-art" aria-hidden="true">
          <div />
          <div />
          <div />
          <div />
          <div />
        </div>
      </div>
      <div className="login-form-wrap">
        <div className="login-form-content">
          <span className="eyebrow">ACESSO RESTRITO</span>
          <h2>Entrar no Artisti CRM</h2>
          <p>Use suas credenciais para acessar a plataforma.</p>
          <form onSubmit={login}>
            {import.meta.env.DEV && (
              <button
                type="button"
                className="text-link"
                onClick={() => {
                  setDemoSelected(!demoSelected);
                  setError('');
                }}
              >
                {localDemo ? 'Usar e-mail e senha' : 'Usar perfil de demonstração'}
              </button>
            )}
            {localDemo ? (
              <label>
                Escolha um perfil de demonstração
                <select value={profile} onChange={(e) => setProfile(e.target.value)}>
                  {[
                    ['cadu', 'Cadu · Gestão'],
                    ['vanessa', 'Vanessa · Atendimento'],
                    ['priscila', 'Priscila · Atendimento'],
                    ['vitoria', 'Vitória · Atendimento'],
                    ['calel', 'Calel · Atendimento'],
                  ].map(([value, label]) => (
                    <option key={value} value={value}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <>
                <label>
                  E-mail
                  <input
                    type="email"
                    autoComplete="username"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                  />
                </label>
                <label>
                  Senha
                  <input
                    type="password"
                    autoComplete="current-password"
                    minLength={1}
                    maxLength={128}
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </label>
              </>
            )}
            {(error || !connected) && (
              <p className="form-error" role="alert">
                {error || 'Servidor indisponível. Tente novamente em alguns instantes.'}
              </p>
            )}
            <button className="button gold" disabled={busy}>
              {busy ? 'Preparando seu acesso…' : 'Entrar no espaço de trabalho'}
              <ArrowRight size={18} />
            </button>
          </form>
          <div className="login-disclaimer">
            <ShieldCheck size={19} />
            <p>
              <strong>
                {localDemo ? 'Ambiente local de demonstração' : 'Acesso restrito • homologação'}
              </strong>
              Integrações desligadas. Não utilize dados de pacientes nesta etapa.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

function IntegrationPage({ platform, leads }: { platform: 'meta' | 'google'; leads: Lead[] }) {
  const name = platform === 'meta' ? 'Meta Ads' : 'Google Ads';
  const associated = leads.filter((l) => l.source === name);
  return (
    <>
      <div className="integration-hero">
        <span className={`integration-logo ${platform}`}>{platform === 'meta' ? '∞' : 'G'}</span>
        <div>
          <h2>{name}</h2>
          <p>Métricas de mídia e resultados registrados no CRM.</p>
        </div>
        <span className="badge pending">
          <i />
          Não conectado
        </span>
      </div>
      <div className="stats-grid">
        {['Investimento', 'Impressões', 'Cliques no link', 'Custo por clique'].map((metric) => (
          <article className="stat-card disconnected" key={metric}>
            <div>
              <span>{metric}</span>
              <Link2 size={16} />
            </div>
            <strong>—</strong>
            <small>Aguardando conexão com a plataforma</small>
          </article>
        ))}
      </div>
      <section className="panel">
        <div className="feature-notice">
          <Link2 size={32} />
          <h2>Integração ainda não configurada</h2>
          <p>
            A sincronização oficial de {name} ainda não está ativa. A configuração de contas,
            permissões e credenciais será feita no backend. Não insira chaves nesta interface.
          </p>
          <div className="integration-steps">
            <span>
              <i>01</i>Autorizar a conta
            </span>
            <ChevronRight size={15} />
            <span>
              <i>02</i>Sincronizar campanhas
            </span>
            <ChevronRight size={15} />
            <span>
              <i>03</i>Acompanhar resultados
            </span>
          </div>
        </div>
        <div className="source-evidence">
          <Info size={18} />
          <p>
            <strong>
              {associated.length} oportunidades com origem “{name}” nesta base local.
            </strong>
            A origem pode vir do cadastro ou de referência recebida pela central. Esta contagem não
            representa conversões verificadas nem métricas sincronizadas da plataforma.
          </p>
        </div>
      </section>
      <div className="tracking-note">
        <ShieldCheck size={19} />
        <p>
          <strong>Um clique não é um lead.</strong> O GTM registrará interações no site. O contato
          será criado quando a central configurada receber uma mensagem no WhatsApp. A atribuição de
          cliques do site ao contato ainda depende da integração de tracking.
        </p>
      </div>
    </>
  );
}
