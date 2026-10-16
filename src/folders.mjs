// The folders of an archive that names each file by its whole path, as ZIP and tar do, built
// as the entries come. One entry can name thousands of folders that hold nothing but each
// other, and each is kept in memory, so folders are counted as well as files.
const MAX_FOLDERS = 250_000;

/**
 * @typedef {{ path: string, name: string, isDirectory: true, directories: Map<string, Folder>,
 *   files: object[] }} Folder
 * @returns {{ root: Folder, addFolder(segments: string[]): void, addFile(segments: string[], entry: object): void }}
 *   `segments` is a path cut at its slashes, with nothing empty in it
 */
export function startFolders() {
  const root = { path: '', name: '', isDirectory: true, directories: new Map(), files: [] };
  let folderCount = 0;
  const childDirectory = (parent, name) => {
    let child = parent.directories.get(name);
    if (!child) {
      folderCount += 1;
      if (folderCount > MAX_FOLDERS) throw new Error('the archive names implausibly many folders');
      const path = parent.path ? `${parent.path}/${name}` : name;
      child = { path, name, isDirectory: true, directories: new Map(), files: [] };
      parent.directories.set(name, child);
    }
    return child;
  };
  return {
    root,
    addFolder: (segments) => {
      segments.reduce(childDirectory, root);
    },
    // Two entries may carry one name, and each has bytes of its own, so files are a list.
    addFile: (segments, entry) => {
      const parent = segments.slice(0, -1).reduce(childDirectory, root);
      parent.files.push({ path: segments.join('/'), name: segments.at(-1), isDirectory: false, ...entry });
    },
  };
}

/** What sits directly inside one folder: its folders, then its files. */
export function listFolder({ directories, files }) {
  return [...directories.values(), ...files];
}
