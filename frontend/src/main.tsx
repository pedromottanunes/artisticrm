import React from 'react';
import ReactDOM from 'react-dom/client';
import '@fontsource/montserrat/latin-400.css';
import '@fontsource/montserrat/latin-500.css';
import '@fontsource/montserrat/latin-600.css';
import '@fontsource/montserrat/latin-700.css';
import { App } from './App';
import './styles.css';
import './responsive.css';
import './mobile-app.css';
import './premium-workspace.css';
import './attendant-leads.css';
import './manager-central.css';
import './manager-pipeline.css';
import './manager-reports.css';
import './inbox.css';
import './clinical-light.css';
import './public-legal.css';
import { registerDeviceWorker } from './pwa';
import { PublicLegalPage, type PublicLegalPageName } from './public-legal';

const publicPages: Record<string, PublicLegalPageName> = {
  '/politica-de-privacidade': 'privacy',
  '/exclusao-de-dados': 'deletion',
};
const pathname = window.location.pathname.replace(/\/+$/, '') || '/';
const publicPage = publicPages[pathname];

void registerDeviceWorker();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {publicPage ? <PublicLegalPage page={publicPage} /> : <App />}
  </React.StrictMode>,
);
