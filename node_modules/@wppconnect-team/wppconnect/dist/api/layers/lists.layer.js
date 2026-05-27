"use strict";
/*
 * This file is part of WPPConnect.
 *
 * WPPConnect is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Lesser General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * WPPConnect is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU Lesser General Public License for more details.
 *
 * You should have received a copy of the GNU Lesser General Public License
 * along with WPPConnect.  If not, see <https://www.gnu.org/licenses/>.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ListsLayer = void 0;
const helpers_1 = require("../helpers");
const catalog_layer_1 = require("./catalog.layer");
class ListsLayer extends catalog_layer_1.CatalogLayer {
    page;
    constructor(page, session, options) {
        super(page, session, options);
        this.page = page;
    }
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
    async createList(name, chatIds = [], colorIndex) {
        return await (0, helpers_1.evaluateAndReturn)(this.page, ({ name, chatIds, colorIndex }) => WPP.lists.create(name, chatIds, colorIndex), { name, chatIds, colorIndex });
    }
    /**
     * Return all custom lists
     * @category Lists
     *
     * @example
     * ```javascript
     * const lists = await client.getAllLists();
     * ```
     */
    async getAllLists() {
        return await (0, helpers_1.evaluateAndReturn)(this.page, () => WPP.lists.list());
    }
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
    async addChatsToList(listId, chatIds) {
        return await (0, helpers_1.evaluateAndReturn)(this.page, ({ listId, chatIds }) => WPP.lists.addChats(listId, chatIds), { listId, chatIds });
    }
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
    async removeChatsFromList(listId, chatIds) {
        return await (0, helpers_1.evaluateAndReturn)(this.page, ({ listId, chatIds }) => WPP.lists.removeChats(listId, chatIds), { listId, chatIds });
    }
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
    async renameList(listId, newName) {
        return await (0, helpers_1.evaluateAndReturn)(this.page, ({ listId, newName }) => WPP.lists.rename(listId, newName), { listId, newName });
    }
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
    async deleteList(listId) {
        return await (0, helpers_1.evaluateAndReturn)(this.page, ({ listId }) => WPP.lists.remove(listId), { listId });
    }
}
exports.ListsLayer = ListsLayer;
