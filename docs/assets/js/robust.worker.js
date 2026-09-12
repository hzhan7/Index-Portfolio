// Module worker for robust jobs (terminated and respawned by the main thread when superseded).
import { serveWorker } from './engine/jobs.js?v=20260912';

serveWorker(self, ['robust']);
