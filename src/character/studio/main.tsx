/**
 * Standalone Character Studio page (development):  /character-studio.html
 * The same studio opens inside the app from the character menu.
 */
import React from 'react';
import { createRoot } from 'react-dom/client';
import '../../index.css';
import { CharacterStudio } from '../../components/character/CharacterStudio';

const params = new URLSearchParams(location.search);
createRoot(document.getElementById('root')!).render(<CharacterStudio initialCharacterId={params.get('character') ?? undefined} />);
