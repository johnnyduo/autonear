// AutoNEAR owner app: one landing page (not connected) and four pages (Home, Approvals, Watch, Vault) plus an Activity drawer.
// The previous 9-screen operator console is kept as deep links reachable from Activity (see app/Shell.jsx).
import { ToastProvider } from './ui.jsx';
import Shell from './app/Shell.jsx';

export default function App() { return <ToastProvider><Shell /></ToastProvider>; }
