import type { ImportJob, VFSNode } from "$lib/modules/documents"

export interface LibraryEntry {
    id: string
    node?: VFSNode
    job?: ImportJob
    interactive: boolean
}

export function mergeLibraryEntries(
    nodes: VFSNode[],
    jobs: ImportJob[],
    parentId: string | null,
): LibraryEntry[] {
    const folderJobs = jobs.filter((job) => job.parentId === parentId)
    const jobsById = new Map(folderJobs.map((job) => [job.id, job]))
    const nodesById = new Map(nodes.map((node) => [node.id, node]))

    const entries: LibraryEntry[] = nodes
        .filter((node) => !jobsById.has(node.id))
        .map((node) => ({ id: node.id, node, interactive: true }))

    for (const job of folderJobs) {
        const node = nodesById.get(job.id)
        entries.push({
            id: job.id,
            ...(node ? { node } : {}),
            job,
            interactive: false,
        })
    }

    return entries
}
