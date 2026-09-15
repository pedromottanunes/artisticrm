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
import { registerDeviceWorker } from './pwa';
void registerDeviceWorker();
ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
