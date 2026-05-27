import { Page } from 'puppeteer';
import { CreateConfig } from '../../config/create-config';
import { CatalogLayer } from './catalog.layer';
export declare class ListsLayer extends CatalogLayer {
    page: Page;
    constructor(page: Page, session?: string, options?: CreateConfig);
    /**
     * Create a new list and optionally add chats to it.
     * Works for both personal and business accounts.
     * @category Lists
     *
     * @example
     * ```javascript
     * const id = await client.createList('Family', ['number@c.us', 'number2@c.us']);
     * console.log(id); // '42'
     * ```
     * @param name List name
     * @param chatIds Chat IDs to add to the list
     * @param colorIndex Optional color index
     */
    createList(name: string, chatIds?: string[], colorIndex?: number): Promise<string>;
    /**
     * Return all custom lists
     * @category Lists
     *
     * @example
     * ```javascript
     * const lists = await client.getAllLists();
     * ```
     */
    getAllLists(): Promise<import("@wppconnect/wa-js/dist/lists").ListInfo[]>;
    /**
     * Add chats to an existing list
     * @category Lists
     *
     * @example
     * ```javascript
     * await client.addChatsToList('42', ['number@c.us', 'number2@c.us']);
     * ```
     * @param listId List ID
     * @param chatIds Chat IDs to add
     */
    addChatsToList(listId: string, chatIds: string[]): Promise<void>;
    /**
     * Remove chats from a list
     * @category Lists
     *
     * @example
     * ```javascript
     * await client.removeChatsFromList('42', ['number@c.us']);
     * ```
     * @param listId List ID
     * @param chatIds Chat IDs to remove
     */
    removeChatsFromList(listId: string, chatIds: string[]): Promise<void>;
    /**
     * Rename a list
     * @category Lists
     *
     * @example
     * ```javascript
     * await client.renameList('42', 'Close Friends');
     * ```
     * @param listId List ID
     * @param newName New name
     */
    renameList(listId: string, newName: string): Promise<void>;
    /**
     * Delete a list
     * @category Lists
     *
     * @example
     * ```javascript
     * await client.deleteList('42');
     * ```
     * @param listId List ID
     */
    deleteList(listId: string): Promise<void>;
}
