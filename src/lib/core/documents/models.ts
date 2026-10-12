export type Bookmark = {
    id: string
    bookId: string
    pageNumber: number
    name: string
    createdAt: number
}

export type UserNote = {
    id: string
    bookId: string
    pageNumber: number
    start: number
    end: number
    text: string
    noteContent: string
    color: "yellow" | "green" | "blue" | "pink" | "purple"
    createdAt: number
}
