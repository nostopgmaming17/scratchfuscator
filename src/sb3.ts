import * as fs from 'fs';
import * as path from 'path';
import JSZip from 'jszip';
import { SB3Project } from './types';

/** Read an .sb3 file and extract the project JSON + assets */
export async function readSB3(filePath: string): Promise<{ project: SB3Project; zip: JSZip }> {
  const data = fs.readFileSync(filePath);
  const zip = await JSZip.loadAsync(data);

  const projectJsonFile = zip.file('project.json');
  if (!projectJsonFile) {
    throw new Error('Invalid .sb3 file: missing project.json');
  }

  const projectJsonStr = await projectJsonFile.async('string');
  const project: SB3Project = JSON.parse(projectJsonStr);

  return { project, zip };
}

/** Write a project back to an .sb3 file, preserving all assets from the original ZIP */
export async function writeSB3(filePath: string, project: SB3Project, zip: JSZip): Promise<void> {
  // Update the project.json in the ZIP
  zip.file('project.json', JSON.stringify(project));

  // Generate the .sb3 (ZIP) file
  const output = await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  });

  fs.writeFileSync(filePath, output);
}

/** Read project.json from a raw JSON string (for console injection mode) */
export function parseProjectJSON(jsonStr: string): SB3Project {
  return JSON.parse(jsonStr);
}
