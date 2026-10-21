import React from 'react';
import {createRoot} from 'react-dom/client';
import Portal from '../app/portal';
createRoot(document.getElementById('root')!).render(<Portal mode={location.pathname==='/admin'?'admin':'customer'} authMode="local"/>);
